-- The auth_request directive is deliberately NOT used: it cannot be skipped on a
-- lua_shared_dict hit, so the miss-path subrequest is issued from Lua, which is
-- why the http block carries a `resolver` (cosockets do their own DNS).

local http = require("resty.http")
local uuid = require("resty.uuid")
local errors = require("errors")
local limit_req = require("resty.limit.req")
local resty_sha256 = require("resty.sha256")
local resty_string = require("resty.string")

local _M = {}

local CACHE = "jwt_cache"
local API_TOKEN_CACHE = "api_token_cache"
local API_TOKEN_MISSES = "api_token_misses"
local API_TOKEN_PREFIX = "iapi_"
local API_TOKEN_MISS_RATE = 10
local API_TOKEN_MISS_BURST = 20

local cfg = {
    authz_url = nil,
    api_token_authz_url = nil,
    mcp_resource_metadata_url = nil,
    authz_connect_timeout_ms = 2000,
    authz_read_timeout_ms = 2000,
}

function _M.init(opts)
    cfg.authz_url = opts.authz_url
    cfg.api_token_authz_url = opts.api_token_authz_url
    cfg.mcp_resource_metadata_url = opts.mcp_resource_metadata_url
    cfg.authz_connect_timeout_ms = opts.authz_connect_timeout_ms or cfg.authz_connect_timeout_ms
    cfg.authz_read_timeout_ms = opts.authz_read_timeout_ms or cfg.authz_read_timeout_ms
end

-- Extract the __Host-sid value from the Cookie header. The stock $cookie_*
-- variables cannot address the dash in the name, hence the manual match.
local function read_sid(cookie)
    if not cookie then
        return nil
    end
    return string.match(cookie, "__Host%-sid=([^;]+)")
end

local function strip_cookie(cookie)
    if not cookie then
        return nil
    end
    local kept = {}
    for pair in string.gmatch(cookie, "[^;]+") do
        local trimmed = string.gsub(pair, "^%s*(.-)%s*$", "%1")
        if trimmed ~= "" and not string.find(trimmed, "^__Host%-sid=") then
            kept[#kept + 1] = trimmed
        end
    end
    if #kept == 0 then
        return nil
    end
    return table.concat(kept, "; ")
end

local function parse_max_age(cache_control)
    if not cache_control or string.find(cache_control, "no%-store") then
        return nil
    end
    local v = string.match(cache_control, "max%-age=(%d+)")
    return v and tonumber(v) or nil
end

local function resolve_bearer(cookie, sid)
    local cache = ngx.shared[CACHE]
    local bearer = cache:get(sid)
    if bearer then
        return bearer
    end

    local httpc = http.new()
    httpc:set_timeouts(
        cfg.authz_connect_timeout_ms,
        cfg.authz_read_timeout_ms,
        cfg.authz_read_timeout_ms
    )
    local res, err = httpc:request_uri(cfg.authz_url, {
        method = "GET",
        headers = { ["Cookie"] = cookie },
    })
    if not res then
        return nil, function() return errors.unavailable(err) end
    end
    if res.status == 401 then
        return nil, errors.unauthorized
    end
    if res.status ~= 200 then
        return nil, function() return errors.unavailable("authz status " .. tostring(res.status)) end
    end
    bearer = res.headers["X-Gateway-Jwt"]
    if not bearer or bearer == "" then
        return nil, function() return errors.unavailable("authz 200 without X-Gateway-Jwt") end
    end

    -- Fixed-size shm with native LRU: set(), never safe_set() (DESIGN 3.11).
    local ttl = parse_max_age(res.headers["Cache-Control"])
    if ttl and ttl > 0 then
        cache:set(sid, bearer, ttl)
    end
    return bearer
end

local function set_request_context()
    local corr = uuid.generate_time_v7()
    ngx.req.set_header("X-Correlation-Id", corr)
    ngx.var.correlation_id = corr

    ngx.req.clear_header("X-Forwarded-For")
    ngx.req.clear_header("X-Forwarded-Proto")
    ngx.req.clear_header("X-Forwarded-Host")
end

function _M.exchange()
    local cookie = ngx.var.http_cookie
    local sid = read_sid(cookie)
    if not sid then
        return errors.unauthorized()
    end

    local bearer, deny = resolve_bearer(cookie, sid)
    if not bearer then
        return deny()
    end

    ngx.req.set_header("Authorization", bearer)

    local remaining = strip_cookie(cookie)
    if remaining then
        ngx.req.set_header("Cookie", remaining)
    else
        ngx.req.clear_header("Cookie")
    end

    set_request_context()
end

function _M.pass_bearer(resource_metadata_url, scope)
    local authorization = ngx.var.http_authorization
    local scheme, token = string.match(authorization or "", "^(%S+) (%S+)$")
    if not scheme or string.lower(scheme) ~= "bearer" or not token then
        local metadata = resource_metadata_url
        if metadata == nil or metadata == "" then
            metadata = cfg.mcp_resource_metadata_url
        end
        return errors.bearer_unauthorized(metadata, scope)
    end

    ngx.req.clear_header("Cookie")
    set_request_context()
end

function _M.pass_instance_token()
    ngx.req.clear_header("Cookie")
    set_request_context()
end

local miss_limiter

local function api_token_miss_limiter()
    if not miss_limiter then
        miss_limiter = assert(limit_req.new(API_TOKEN_MISSES, API_TOKEN_MISS_RATE, API_TOKEN_MISS_BURST))
    end
    return miss_limiter
end

local function sha256_hex(value)
    local digest = resty_sha256:new()
    digest:update(value)
    return resty_string.to_hex(digest:final())
end

local function api_token_unavailable(reason)
    ngx.log(ngx.ERR, "API token exchange failed: ", reason)
    return errors.sql_api_unavailable
end

local function exchange_api_token(token)
    local cache = ngx.shared[API_TOKEN_CACHE]
    local key = sha256_hex(token)
    local jwt = cache:get(key)
    if jwt then
        return jwt
    end

    local delay, limit_err = api_token_miss_limiter():incoming(ngx.var.remote_addr, true)
    if not delay then
        if limit_err == "rejected" then
            return nil, errors.too_many_requests
        end
        return nil, api_token_unavailable("limiter: " .. tostring(limit_err))
    end

    local httpc = http.new()
    httpc:set_timeouts(
        cfg.authz_connect_timeout_ms,
        cfg.authz_read_timeout_ms,
        cfg.authz_read_timeout_ms
    )
    local res, err = httpc:request_uri(cfg.api_token_authz_url, {
        method = "GET",
        headers = { ["Authorization"] = "Bearer " .. token },
    })
    if not res then
        return nil, api_token_unavailable(err)
    end
    if res.status == 401 then
        return nil, errors.sql_api_unauthorized
    end
    if res.status ~= 200 then
        return nil, api_token_unavailable("authz status " .. tostring(res.status))
    end
    jwt = res.headers["X-Gateway-Jwt"]
    if not jwt or jwt == "" then
        return nil, api_token_unavailable("authz 200 without X-Gateway-Jwt")
    end

    local ttl = parse_max_age(res.headers["Cache-Control"])
    if ttl and ttl > 0 then
        cache:set(key, jwt, ttl)
    end
    return jwt
end

function _M.api_token()
    local scheme, token = string.match(ngx.var.http_authorization or "", "^(%S+) (%S+)$")
    if not scheme or string.lower(scheme) ~= "bearer" then
        token = nil
    end
    if not token or string.sub(token, 1, #API_TOKEN_PREFIX) ~= API_TOKEN_PREFIX then
        return _M.pass_instance_token()
    end

    local jwt, deny = exchange_api_token(token)
    if not jwt then
        return deny()
    end

    ngx.req.set_header("Authorization", jwt)
    ngx.req.clear_header("Cookie")
    set_request_context()
end

return _M
