use claude_conductor_lib::slash::parse::{extract_args, parse_frontmatter};

#[test]
fn parses_description_from_frontmatter() {
    let body = "---\nname: commit\ndescription: Stage and commit\n---\nBody text\n";
    let fm = parse_frontmatter(body);
    assert_eq!(fm.description.as_deref(), Some("Stage and commit"));
    assert_eq!(fm.name.as_deref(), Some("commit"));
}

#[test]
fn missing_frontmatter_returns_empty_struct() {
    let body = "Just body text, no frontmatter\n";
    let fm = parse_frontmatter(body);
    assert!(fm.description.is_none());
    assert!(fm.name.is_none());
}

#[test]
fn malformed_frontmatter_skips_bad_lines() {
    let body = "---\nbroken line no colon\ndescription: kept\n---\nbody\n";
    let fm = parse_frontmatter(body);
    assert_eq!(fm.description.as_deref(), Some("kept"));
}

#[test]
fn unterminated_frontmatter_returns_empty() {
    let body = "---\ndescription: oops\nbody\n";
    let fm = parse_frontmatter(body);
    assert!(fm.description.is_none());
}

#[test]
fn extracts_arguments_line_from_body() {
    let body = "Some text\nARGUMENTS: <flag>\nMore text\n";
    assert_eq!(extract_args(body).as_deref(), Some("<flag>"));
}

#[test]
fn no_arguments_line_returns_none() {
    let body = "Some text\nnothing here\n";
    assert!(extract_args(body).is_none());
}

#[test]
fn empty_arguments_line_returns_none() {
    let body = "ARGUMENTS:   \n";
    assert!(extract_args(body).is_none());
}
