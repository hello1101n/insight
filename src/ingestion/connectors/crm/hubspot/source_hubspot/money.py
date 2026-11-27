"""Which HubSpot properties hold money. The connector neither requests nor stores them."""

from __future__ import annotations

from source_hubspot.models import PropertyDescriptor

# Standard properties that carry an amount, a currency or an exchange rate. A
# portal can define them without the currency flag, so the name alone decides.
MONEY_PROPERTY_NAMES: frozenset[str] = frozenset(
    {
        "amount",
        "amount_in_home_currency",
        "annualrevenue",
        "deal_currency_code",
        "hs_acv",
        "hs_analytics_revenue",
        "hs_annual_revenue_currency_code",
        "hs_arr",
        "hs_closed_amount",
        "hs_closed_amount_in_home_currency",
        "hs_exchange_rate",
        "hs_forecast_amount",
        "hs_lead_closed_won_deals_amount",
        "hs_lead_currency_code",
        "hs_lead_pipeline_value",
        "hs_mrr",
        "hs_open_amount_in_home_currency",
        "hs_projected_amount",
        "hs_projected_amount_in_home_currency",
        "hs_revenue_range",
        "hs_tcv",
        "hs_total_deal_value",
        "hs_weighted_pipeline_in_company_currency",
        "recent_deal_amount",
        "total_revenue",
    }
)


def is_money_property(descriptor: PropertyDescriptor) -> bool:
    """A standard money property, or any property the portal displays as currency."""
    if descriptor.name in MONEY_PROPERTY_NAMES:
        return True
    if descriptor.showCurrencySymbol:
        return True
    return descriptor.numberDisplayHint == "currency"
