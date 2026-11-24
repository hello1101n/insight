{{- define "insight-authenticator.fullname" -}}
{{ .Release.Name }}-authenticator
{{- end }}

{{- define "insight-authenticator.labels" -}}
app.kubernetes.io/name: authenticator
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "insight-authenticator.selectorLabels" -}}
app.kubernetes.io/name: authenticator
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "insight-authenticator.authnTlsSecret" -}}
{{- .Values.tlsDiscovery.certSecret | default (printf "%s-authn-tls-cert" (include "insight-authenticator.fullname" .)) -}}
{{- end }}

{{- define "insight-authenticator.gatewayIssuer" -}}
{{- printf "https://%s.%s.svc.cluster.local:%v" (include "insight-authenticator.fullname" .) .Release.Namespace .Values.tlsDiscovery.port -}}
{{- end }}
