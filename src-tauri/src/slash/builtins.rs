use super::{SlashEntry, SlashSource};

pub fn all() -> Vec<SlashEntry> {
    vec![
        e("help",        None,           "Show Claude Code help"),
        e("clear",       None,           "Clear conversation context"),
        e("model",       Some("<name>"), "Switch active model"),
        e("init",        None,           "Initialize CLAUDE.md for the repo"),
        e("config",      None,           "Open settings UI"),
        e("permissions", None,           "Open permissions UI"),
        e("exit",        None,           "Exit Claude Code"),
        e("cost",        None,           "Show session token cost"),
        e("compact",     None,           "Compact conversation history"),
    ]
}

fn e(name: &str, args: Option<&str>, desc: &str) -> SlashEntry {
    SlashEntry {
        name: name.to_string(),
        args: args.map(str::to_string),
        description: desc.to_string(),
        source: SlashSource::Builtin,
    }
}
