//! Metered-billing guard. The chat hub consumes the user's Pro/Max
//! subscription quota (same pool as interactive `claude`); it refuses to run
//! under any env that would route billing to the metered Anthropic API.

#[derive(thiserror::Error, Debug)]
pub enum BillingError {
    #[error("metered billing detected: {0} is set. Running claude under the daemon would bill the metered Anthropic API instead of the Pro/Max subscription. Refusing to spawn. Unset {0} to use the subscription path, or run a non-`-p` interactive `claude` session in a terminal.")]
    Metered(String),
}

/// Env vars whose presence routes claude to metered billing instead of the
/// Pro/Max subscription. Per https://code.claude.com/docs/en/authentication
/// the auth precedence is: ANTHROPIC_API_KEY > apiKeyHelper > CLAUDE_CODE_OAUTH_TOKEN
/// > Bedrock/Vertex envs > /login OAuth. Of those, only ANTHROPIC_API_KEY,
/// Bedrock, and Vertex are guaranteed metered. ANTHROPIC_AUTH_TOKEN is for
/// custom-auth proxies and may route either way; we err on the side of refusing.
/// CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) is subscription-billed
/// and explicitly NOT in this list.
const METERED_ENV_VARS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
];

/// Refuse to proceed if any env var that would route billing to the metered
/// API is set. The chat hub is designed to consume the user's existing Pro/Max
/// subscription quota (same pool as interactive `claude` sessions); we do not
/// support metered-billing operation. `env_get` is parameterised for testability.
pub fn check_metered_billing(env_get: &dyn Fn(&str) -> Option<String>) -> Result<(), BillingError> {
    for key in METERED_ENV_VARS {
        if env_get(key).map(|v| !v.is_empty()).unwrap_or(false) {
            return Err(BillingError::Metered((*key).to_string()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metered_billing_detected_when_anthropic_api_key_set() {
        let env = |k: &str| if k == "ANTHROPIC_API_KEY" { Some("sk-test-123".into()) } else { None };
        let r = check_metered_billing(&env);
        assert!(matches!(r, Err(BillingError::Metered(ref k)) if k == "ANTHROPIC_API_KEY"));
    }

    #[test]
    fn metered_billing_detected_for_bedrock_and_vertex() {
        for key in ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_AUTH_TOKEN"] {
            let env = |k: &str| if k == key { Some("1".into()) } else { None };
            let r = check_metered_billing(&env);
            assert!(matches!(r, Err(BillingError::Metered(ref k)) if k == key), "key {key} not detected");
        }
    }

    #[test]
    fn metered_billing_not_detected_when_no_keys_set() {
        let env = |_: &str| None;
        assert!(check_metered_billing(&env).is_ok());
    }

    #[test]
    fn metered_billing_ignores_empty_string() {
        let env = |k: &str| if k == "ANTHROPIC_API_KEY" { Some(String::new()) } else { None };
        assert!(check_metered_billing(&env).is_ok());
    }

    #[test]
    fn metered_billing_does_not_flag_oauth_token() {
        // CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) is subscription-billed
        // per the auth docs; must not trigger the guard.
        let env = |k: &str| if k == "CLAUDE_CODE_OAUTH_TOKEN" { Some("oat-test".into()) } else { None };
        assert!(check_metered_billing(&env).is_ok());
    }
}
