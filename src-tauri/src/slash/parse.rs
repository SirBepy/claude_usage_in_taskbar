#[derive(Default, Debug)]
pub struct Frontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
}

pub fn parse_frontmatter(body: &str) -> Frontmatter {
    let mut fm = Frontmatter::default();
    let trimmed = body.trim_start();
    if !trimmed.starts_with("---") {
        return fm;
    }
    let after_open = match trimmed[3..].find('\n') {
        Some(i) => &trimmed[3 + i + 1..],
        None => return fm,
    };
    let end = match after_open.find("\n---") {
        Some(i) => i,
        None => return fm,
    };
    for line in after_open[..end].lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let k = k.trim();
        let v = v.trim();
        if v.is_empty() {
            continue;
        }
        match k {
            "name" => fm.name = Some(v.to_string()),
            "description" => fm.description = Some(v.to_string()),
            _ => {}
        }
    }
    fm
}

pub fn extract_args(body: &str) -> Option<String> {
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("ARGUMENTS:") {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}
