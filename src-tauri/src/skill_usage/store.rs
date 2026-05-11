use crate::skill_usage::types::{
    InvocationCounts, InvocationSource, SkillDetail, SkillUsageEntry, SkillUsageEvent,
    SkillUsageWeek, TokenBreakdown,
};
use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

fn day_of(ts: &str) -> &str {
    ts.split('T').next().unwrap_or(ts)
}

fn events_path(dir: &Path, day: &str) -> PathBuf {
    dir.join(format!("events-{day}.jsonl"))
}

fn sessions_path(dir: &Path, day: &str) -> PathBuf {
    dir.join(format!("sessions-{day}.json"))
}

pub fn append_events(dir: &Path, events: &[SkillUsageEvent]) -> std::io::Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    let mut by_day: HashMap<String, Vec<&SkillUsageEvent>> = HashMap::new();
    for e in events {
        by_day.entry(day_of(&e.ts).to_string()).or_default().push(e);
    }
    for (day, evs) in by_day {
        let path = events_path(dir, &day);
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        for e in evs {
            let line = serde_json::to_string(e).unwrap();
            writeln!(f, "{line}")?;
        }
    }
    Ok(())
}

pub fn mark_session(dir: &Path, session_id: &str, day: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = sessions_path(dir, day);
    let mut set: BTreeSet<String> = if path.exists() {
        let raw = std::fs::read_to_string(&path)?;
        serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| v.get("session_ids").cloned())
            .and_then(|v| v.as_array().cloned())
            .map(|arr| {
                arr.into_iter()
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        BTreeSet::new()
    };
    set.insert(session_id.to_string());
    let payload = serde_json::json!({
        "day": day,
        "session_ids": set.iter().collect::<Vec<_>>(),
    });
    std::fs::write(&path, serde_json::to_string_pretty(&payload).unwrap())?;
    Ok(())
}

fn last_n_days(today: &str, n: i64) -> Vec<String> {
    let Ok(end) = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d") else {
        return vec![];
    };
    (0..n)
        .map(|i| {
            (end - chrono::Duration::days(i))
                .format("%Y-%m-%d")
                .to_string()
        })
        .collect()
}

fn read_events_for_day(dir: &Path, day: &str) -> Vec<SkillUsageEvent> {
    let path = events_path(dir, day);
    let Ok(file) = std::fs::File::open(&path) else {
        return vec![];
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<SkillUsageEvent>(&l).ok())
        .collect()
}

fn read_sessions_for_day(dir: &Path, day: &str) -> BTreeSet<String> {
    let path = sessions_path(dir, day);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return BTreeSet::new();
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("session_ids").cloned())
        .and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.into_iter()
                .filter_map(|s| s.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

pub fn get_week(dir: &Path, today: &str) -> SkillUsageWeek {
    let days = last_n_days(today, 7);
    let mut all_sessions: BTreeSet<String> = BTreeSet::new();
    let mut per_skill: HashMap<String, (InvocationCounts, BTreeSet<String>, TokenBreakdown)> =
        HashMap::new();
    for d in &days {
        all_sessions.extend(read_sessions_for_day(dir, d));
        for e in read_events_for_day(dir, d) {
            let entry = per_skill.entry(e.skill.clone()).or_default();
            entry.0.total += 1;
            match e.source {
                InvocationSource::Manual => entry.0.manual += 1,
                InvocationSource::Skill => entry.0.skill += 1,
                InvocationSource::Auto => entry.0.auto += 1,
            }
            entry.1.insert(e.session_id.clone());
            entry.2.input += e.tokens.input;
            entry.2.output += e.tokens.output;
            entry.2.cache_read += e.tokens.cache_read;
            entry.2.cache_create += e.tokens.cache_create;
        }
    }
    let mut entries: Vec<SkillUsageEntry> = per_skill
        .into_iter()
        .map(|(skill, (invocations, chats, tokens))| SkillUsageEntry {
            skill,
            invocations,
            chats: chats.len() as u32,
            tokens,
        })
        .collect();
    entries.sort_by(|a, b| b.tokens.total().cmp(&a.tokens.total()));
    SkillUsageWeek {
        entries,
        total_sessions: all_sessions.len() as u32,
    }
}

pub fn get_detail(dir: &Path, today: &str, skill: &str) -> SkillDetail {
    let days = last_n_days(today, 7);
    let mut events: Vec<SkillUsageEvent> = days
        .iter()
        .flat_map(|d| read_events_for_day(dir, d))
        .filter(|e| e.skill == skill)
        .collect();
    events.sort_by(|a, b| b.ts.cmp(&a.ts));
    let mut counts = InvocationCounts::default();
    for e in &events {
        counts.total += 1;
        match e.source {
            InvocationSource::Manual => counts.manual += 1,
            InvocationSource::Skill => counts.skill += 1,
            InvocationSource::Auto => counts.auto += 1,
        }
    }
    SkillDetail {
        skill: skill.to_string(),
        invocations: counts,
        events,
    }
}
