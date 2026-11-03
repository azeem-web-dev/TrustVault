//! Rate limits on key use, enforced inside keyd.
//!
//! Tickets already restrict WHICH keys can be opened; these limits restrict
//! HOW MANY, so that even a compromised API impersonating real users cannot
//! decrypt the whole store quickly, and the attempt shows up as refusals in
//! the ledger. Fixed windows, in memory (a restart resets them; restarts
//! are themselves ledgered).
//!
//! Defaults (environment variables override):
//!   KEYD_LIMIT_USER_PER_MIN       60    document unwraps per user per minute
//!   KEYD_LIMIT_USER_PER_HOUR      600   ... per user per hour
//!   KEYD_LIMIT_ALL_PER_MIN        600   all user document unwraps per minute
//!   KEYD_LIMIT_SYSTEM_PER_HOUR    2000  rescan unwraps per hour (0 = rescan disabled)
//!   KEYD_LIMIT_MAINT_PER_HOUR     0     re-encryption unwraps per hour (0 = disabled;
//!                                       the operator enables it for an emergency run)
//!   KEYD_LIMIT_TOTP_PER_USER_10MIN 20   TOTP secret unwraps per user per 10 minutes
//!   KEYD_LIMIT_REWRAP_PER_MIN     20000 rewraps per minute
//!   KEYD_LIMIT_REFUSALS_LOGGED_PER_MIN 120 refusals written to the ledger per
//!                                       minute; the rest are counted and the
//!                                       count is written with the next one

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone, Debug)]
pub struct Limits {
    pub user_per_min: u32,
    pub user_per_hour: u32,
    pub all_per_min: u32,
    pub system_per_hour: u32,
    pub maint_per_hour: u32,
    pub totp_per_user_10min: u32,
    pub rewrap_per_min: u32,
    pub refusals_logged_per_min: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            user_per_min: 60,
            user_per_hour: 600,
            all_per_min: 600,
            system_per_hour: 2000,
            maint_per_hour: 0,
            totp_per_user_10min: 20,
            rewrap_per_min: 20_000,
            refusals_logged_per_min: 120,
        }
    }
}

impl Limits {
    pub fn from_env() -> Result<Self, String> {
        let mut l = Limits::default();
        let get = |name: &str, v: &mut u32| -> Result<(), String> {
            if let Ok(s) = std::env::var(name) {
                *v = s.trim().parse().map_err(|_| format!("{name} must be a whole number"))?;
            }
            Ok(())
        };
        get("KEYD_LIMIT_USER_PER_MIN", &mut l.user_per_min)?;
        get("KEYD_LIMIT_USER_PER_HOUR", &mut l.user_per_hour)?;
        get("KEYD_LIMIT_ALL_PER_MIN", &mut l.all_per_min)?;
        get("KEYD_LIMIT_SYSTEM_PER_HOUR", &mut l.system_per_hour)?;
        get("KEYD_LIMIT_MAINT_PER_HOUR", &mut l.maint_per_hour)?;
        get("KEYD_LIMIT_TOTP_PER_USER_10MIN", &mut l.totp_per_user_10min)?;
        get("KEYD_LIMIT_REWRAP_PER_MIN", &mut l.rewrap_per_min)?;
        get("KEYD_LIMIT_REFUSALS_LOGGED_PER_MIN", &mut l.refusals_logged_per_min)?;
        Ok(l)
    }
}

pub struct RateLimiter {
    pub limits: Limits,
    windows: Mutex<HashMap<String, (u64, u32)>>,
}

impl RateLimiter {
    pub fn new(limits: Limits) -> Self {
        RateLimiter { limits, windows: Mutex::new(HashMap::new()) }
    }

    /// All-or-nothing: every (key, window seconds, limit) must have room;
    /// only then are all counted.
    pub fn take(&self, buckets: &[(String, u64, u32)], now: u64) -> bool {
        let mut w = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        if w.len() > 50_000 {
            w.retain(|k, (win, _)| {
                let secs = k.rsplit(':').next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(3600);
                *win == now / secs
            });
        }
        for (key, secs, limit) in buckets {
            let id = now / secs;
            let used = match w.get(&format!("{key}:{secs}")) {
                Some((win, n)) if *win == id => *n,
                _ => 0,
            };
            if used >= *limit {
                return false;
            }
        }
        for (key, secs, _) in buckets {
            let id = now / secs;
            let e = w.entry(format!("{key}:{secs}")).or_insert((id, 0));
            if e.0 != id {
                *e = (id, 0);
            }
            e.1 += 1;
        }
        true
    }

    pub fn user_unwrap(&self, user: &str, now: u64) -> bool {
        let l = &self.limits;
        self.take(&[(format!("u:{user}"), 60, l.user_per_min), (format!("u:{user}"), 3600, l.user_per_hour), ("all".into(), 60, l.all_per_min)], now)
    }

    pub fn system_unwrap(&self, action: &str, now: u64) -> bool {
        let limit = if action == "reencrypt" { self.limits.maint_per_hour } else { self.limits.system_per_hour };
        self.take(&[(format!("sys:{action}"), 3600, limit)], now)
    }

    pub fn totp_unwrap(&self, user: &str, now: u64) -> bool {
        self.take(&[(format!("totp:{user}"), 600, self.limits.totp_per_user_10min)], now)
    }

    pub fn rewrap(&self, now: u64) -> bool {
        self.take(&[("rewrap".into(), 60, self.limits.rewrap_per_min)], now)
    }

    pub fn log_refusal(&self, now: u64) -> bool {
        self.take(&[("refusals".into(), 60, self.limits.refusals_logged_per_min)], now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limiter() -> RateLimiter {
        RateLimiter::new(Limits { user_per_min: 3, user_per_hour: 5, all_per_min: 4, system_per_hour: 2, maint_per_hour: 0, totp_per_user_10min: 2, rewrap_per_min: 1, refusals_logged_per_min: 1 })
    }

    #[test]
    fn per_user_minute_and_hour() {
        let r = limiter();
        let t = 3600 * 1000;
        assert!(r.user_unwrap("a", t) && r.user_unwrap("a", t) && r.user_unwrap("a", t));
        assert!(!r.user_unwrap("a", t), "4th in a minute");
        assert!(r.user_unwrap("a", t + 60));
        assert!(r.user_unwrap("a", t + 120));
        assert!(!r.user_unwrap("a", t + 180), "6th in an hour");
        assert!(r.user_unwrap("a", t + 3600));
    }

    #[test]
    fn global_limit_spans_users() {
        let r = limiter();
        let t = 7200;
        assert!(r.user_unwrap("a", t) && r.user_unwrap("b", t) && r.user_unwrap("c", t) && r.user_unwrap("d", t));
        assert!(!r.user_unwrap("e", t), "5th unwrap in the minute across users");
    }

    #[test]
    fn refused_attempts_do_not_consume() {
        let r = limiter();
        for _ in 0..10 {
            r.user_unwrap("a", 60);
        }
        // "b" is only blocked by the global limit (4), which a refused call does not use up.
        let r2 = limiter();
        for _ in 0..10 {
            r2.user_unwrap("a", 60);
        }
        assert!(r2.user_unwrap("b", 60));
    }

    #[test]
    fn system_and_maintenance_classes() {
        let r = limiter();
        assert!(r.system_unwrap("rescan", 0) && r.system_unwrap("rescan", 0));
        assert!(!r.system_unwrap("rescan", 0));
        assert!(!r.system_unwrap("reencrypt", 0), "maintenance disabled by default");
        assert!(r.totp_unwrap("u", 0) && r.totp_unwrap("u", 0) && !r.totp_unwrap("u", 0));
        assert!(r.rewrap(0) && !r.rewrap(0));
    }
}
