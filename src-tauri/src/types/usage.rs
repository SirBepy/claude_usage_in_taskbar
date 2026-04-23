use serde::{Deserialize, Serialize};

/// A single usage poll result, captured at a point in time.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct UsageSnapshot {
    pub captured_at: String,           // RFC3339 / ISO8601
    pub five_hour: WindowUsage,
    pub seven_day: WindowUsage,
    #[serde(default)]
    pub extra_usage: Option<ExtraUsage>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WindowUsage {
    pub utilization: f64,
    pub resets_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ExtraUsage {
    pub is_enabled: bool,
    pub monthly_limit: f64,
    pub used_credits: f64,
    pub utilization: f64,
    pub currency: String,
}
