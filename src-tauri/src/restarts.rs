//! How often a crashed sidecar is started again: a few times, but not in a loop.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

pub struct Restarts {
    max: usize,
    window: Duration,
    recent: VecDeque<Instant>,
}

impl Restarts {
    /// At most `max` restarts within any `window`.
    pub fn new(max: usize, window: Duration) -> Restarts {
        Restarts {
            max,
            window,
            recent: VecDeque::new(),
        }
    }

    /// Whether to restart now, which then counts as one.
    pub fn allow(&mut self, now: Instant) -> bool {
        while self
            .recent
            .front()
            .is_some_and(|&at| now.duration_since(at) >= self.window)
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= self.max {
            return false;
        }
        self.recent.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    #[test]
    fn allows_a_few_restarts_then_stops() {
        let start = Instant::now();
        let mut restarts = Restarts::new(3, 10 * MINUTE);
        assert!(restarts.allow(start));
        assert!(restarts.allow(start + MINUTE));
        assert!(restarts.allow(start + 2 * MINUTE));
        assert!(!restarts.allow(start + 3 * MINUTE));
    }

    #[test]
    fn crashes_long_ago_no_longer_count() {
        let start = Instant::now();
        let mut restarts = Restarts::new(3, 10 * MINUTE);
        for minute in 0..3 {
            assert!(restarts.allow(start + minute * MINUTE));
        }
        assert!(restarts.allow(start + 10 * MINUTE));
        assert!(!restarts.allow(start + 10 * MINUTE + Duration::from_secs(1)));
    }
}
