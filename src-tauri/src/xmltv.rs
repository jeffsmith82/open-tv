use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use flate2::read::GzDecoder;
use quick_xml::Reader;
use quick_xml::events::Event;

use crate::{
    log, sql,
    types::Source,
    utils::get_user_agent_from_source,
};

// Default when a source hasn't set its own epg_retention_days - how far
// back past programmes are kept, so they stay available to browse/catch
// up on (see epg_dispatch's read side, which uses the same setting).
pub const DEFAULT_EPG_RETENTION_DAYS: i64 = 7;
const EPG_LOOKAHEAD_SECONDS: i64 = 7 * 24 * 60 * 60;

struct ParsedProgramme {
    tvg_id: String,
    title: String,
    description: String,
    start_timestamp: i64,
    end_timestamp: i64,
}

enum TextTarget {
    None,
    Title,
    Desc,
}

pub async fn refresh_epg(source: Source) -> Result<()> {
    let url = source.epg_url.clone().context("no epg url")?;
    refresh_epg_from_url(source, url).await
}

pub async fn refresh_epg_from_url(source: Source, url: String) -> Result<()> {
    let source_id = source.id.context("no source id")?;
    let user_agent = get_user_agent_from_source(&source)?;
    let client = reqwest::Client::builder().user_agent(user_agent).build()?;
    let mut response = client.get(&url).send().await?;
    if !response.status().is_success() {
        bail!("Failed to fetch EPG, status: {}", response.status());
    }
    let tmp_path = get_tmp_path();
    {
        let mut file = std::fs::File::create(&tmp_path)?;
        while let Some(chunk) = response.chunk().await? {
            file.write_all(&chunk)?;
        }
    }
    let known_tvg_ids: HashSet<String> = sql::get_tvg_ids_for_source(source_id)?
        .iter()
        .map(|id| crate::utils::normalize_tvg_id(id))
        .collect();
    let retention_days = source
        .epg_retention_days
        .map(|d| d as i64)
        .unwrap_or(DEFAULT_EPG_RETENTION_DAYS);
    let programmes = parse_xmltv(&tmp_path, &known_tvg_ids, retention_days * 24 * 60 * 60)?;
    log::log(format!(
        "Parsed {} EPG programmes for source {}",
        programmes.len(),
        source.name
    ));
    let cached_at = Utc::now().timestamp();
    let mut sql_conn = sql::get_conn()?;
    let tx = sql_conn.transaction()?;
    sql::delete_epg_programmes_by_source(&tx, source_id)?;
    for p in &programmes {
        sql::insert_epg_programme(
            &tx,
            source_id,
            &p.tvg_id,
            &p.title,
            &p.description,
            p.start_timestamp,
            p.end_timestamp,
            cached_at,
            false,
            None,
        )?;
    }
    sql::analyze(&tx)?;
    tx.commit()?;
    Ok(())
}

// Refreshing already re-applies the current retention setting (it wipes and
// re-parses with today's lookback), so this only matters when you lower
// retention_days after already having more history stored than that, and
// want it trimmed immediately rather than waiting for the next refresh.
pub fn prune_old_epg(source: Source) -> Result<()> {
    let source_id = source.id.context("no source id")?;
    let retention_days = source
        .epg_retention_days
        .map(|d| d as i64)
        .unwrap_or(DEFAULT_EPG_RETENTION_DAYS);
    let cutoff = Utc::now().timestamp() - retention_days * 24 * 60 * 60;
    sql::prune_old_epg(source_id, cutoff)
}

fn get_tmp_path() -> String {
    let mut path = directories::ProjectDirs::from("dev", "fredol", "open-tv")
        .unwrap()
        .cache_dir()
        .to_owned();
    if !path.exists() {
        std::fs::create_dir_all(&path).unwrap();
    }
    path.push("get_epg.dat");
    path.to_string_lossy().to_string()
}

fn open_reader(path: &str) -> Result<Box<dyn BufRead>> {
    let mut header = [0u8; 2];
    let is_gzip = {
        let mut peek = std::fs::File::open(path)?;
        peek.read_exact(&mut header).is_ok() && header == [0x1f, 0x8b]
    };
    let file = std::fs::File::open(path)?;
    if is_gzip {
        Ok(Box::new(BufReader::new(GzDecoder::new(file))))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

fn parse_xmltv(
    path: &str,
    known_tvg_ids: &HashSet<String>,
    lookback_seconds: i64,
) -> Result<Vec<ParsedProgramme>> {
    let now = Utc::now().timestamp();
    let from_ts = now - lookback_seconds;
    let to_ts = now + EPG_LOOKAHEAD_SECONDS;

    let mut xml_reader = Reader::from_reader(open_reader(path)?);
    xml_reader.config_mut().trim_text(true);

    let mut programmes = Vec::new();
    let mut buf = Vec::new();
    let mut current: Option<(String, i64, i64)> = None;
    let mut current_title = String::new();
    let mut current_desc = String::new();
    let mut text_target = TextTarget::None;

    loop {
        let event = xml_reader.read_event_into(&mut buf)?;
        match event {
            Event::Eof => break,
            Event::Start(e) if e.name().as_ref() == "programme" => {
                current = read_programme_attrs(&e, known_tvg_ids, from_ts, to_ts);
                current_title.clear();
                current_desc.clear();
            }
            Event::Start(e) if e.name().as_ref() == "title" => {
                text_target = TextTarget::Title;
            }
            Event::Start(e) if e.name().as_ref() == "desc" => {
                text_target = TextTarget::Desc;
            }
            Event::End(e) if e.name().as_ref() == "title" || e.name().as_ref() == "desc" => {
                text_target = TextTarget::None;
            }
            Event::Text(t) if current.is_some() => {
                let decoded = quick_xml::escape::unescape(&t).unwrap_or_default();
                match text_target {
                    TextTarget::Title => current_title.push_str(&decoded),
                    TextTarget::Desc => current_desc.push_str(&decoded),
                    TextTarget::None => {}
                }
            }
            Event::End(e) if e.name().as_ref() == "programme" => {
                if let Some((tvg_id, start_timestamp, end_timestamp)) = current.take() {
                    programmes.push(ParsedProgramme {
                        tvg_id,
                        title: current_title.clone(),
                        description: current_desc.clone(),
                        start_timestamp,
                        end_timestamp,
                    });
                }
            }
            _ => {}
        }
        buf.clear();
    }
    Ok(programmes)
}

fn read_programme_attrs(
    e: &quick_xml::events::BytesStart,
    known_tvg_ids: &HashSet<String>,
    from_ts: i64,
    to_ts: i64,
) -> Option<(String, i64, i64)> {
    let mut channel_id = None;
    let mut start = None;
    let mut stop = None;
    for attr in e.attributes().flatten() {
        match attr.key.as_ref() {
            "channel" => channel_id = Some(crate::utils::normalize_tvg_id(&attr.value)),
            "start" => start = parse_xmltv_time(&attr.value),
            "stop" => stop = parse_xmltv_time(&attr.value),
            _ => {}
        }
    }
    let channel_id = channel_id?;
    let start = start?;
    let stop = stop?;
    if !known_tvg_ids.contains(&channel_id) || stop < from_ts || start > to_ts {
        return None;
    }
    Some((channel_id, start, stop))
}

fn parse_xmltv_time(raw: &str) -> Option<i64> {
    DateTime::parse_from_str(raw.trim(), "%Y%m%d%H%M%S %z")
        .ok()
        .map(|d| d.timestamp())
}
