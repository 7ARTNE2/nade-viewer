//! Portable favorites: no sender database IDs or filesystem paths are trusted.
use super::*;

const FORMAT: &str = "nade-viewer-favorites";
const VERSION: u32 = 1;

// MessagePack bin values, rather than arrays of integer pixels or base64 strings.
#[derive(Clone)]
struct ImageBytes(Vec<u8>);
impl Serialize for ImageBytes {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(&self.0)
    }
}
impl<'de> Deserialize<'de> for ImageBytes {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct BytesVisitor;
        impl<'de> Visitor<'de> for BytesVisitor {
            type Value = ImageBytes;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("binary image data")
            }
            fn visit_bytes<E: serde::de::Error>(self, value: &[u8]) -> Result<Self::Value, E> {
                Ok(ImageBytes(value.to_vec()))
            }
            fn visit_byte_buf<E: serde::de::Error>(self, value: Vec<u8>) -> Result<Self::Value, E> {
                Ok(ImageBytes(value))
            }
        }
        deserializer.deserialize_byte_buf(BytesVisitor)
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct SharedFavorite {
    id: u64,
    snapshot: Snapshot,
    saved_at: String,
    source_label: String,
    normal_jpg: Option<ImageBytes>,
    wide_jpg: Option<ImageBytes>,
}

#[derive(Serialize, Deserialize)]
struct SharedCollection {
    id: u64,
    name: String,
    map: String,
}

#[derive(Serialize, Deserialize)]
struct SharePackage {
    format: String,
    version: u32,
    exported_at: String,
    favorites: Vec<SharedFavorite>,
    collections: Vec<SharedCollection>,
    memberships: Vec<(u64, u64)>, // (package collection ID, package favorite ID)
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ShareScope {
    Collection { collection_id: i64 },
    Map { map: String },
    All,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Import {
        code: "invalid_share_package",
        message: message.into(),
    }
}

fn portable_snapshot(snapshot: &Snapshot) -> Snapshot {
    let mut snapshot = snapshot.clone();
    snapshot.detail.preview.id = 0;
    snapshot.detail.preview.favorite_id = None;
    snapshot.raw.source_index = None;
    snapshot.detail.map_image_path = None;
    snapshot.detail.preview_image_path = None;
    snapshot.detail.screenshot_image_path = None;
    snapshot.detail.screenshot_wide_image_path = None;
    snapshot
}

// Incomplete lineups cannot use source:<id> on a different installation. Use a
// content fingerprint, also checked against existing legacy source-only saves.
fn portable_identity(snapshot: &Snapshot) -> AppResult<String> {
    if let Some(key) = identity(&snapshot.raw)? {
        return Ok(key);
    }
    let bytes = serde_json::to_vec(&portable_snapshot(snapshot))?;
    Ok(format!("share-v1:{:x}", Sha256::digest(bytes)))
}

fn read_image(path: &Option<String>, root: &Path) -> AppResult<Option<ImageBytes>> {
    path.as_ref()
        .map(|path| {
            let path = fs::canonicalize(path)?;
            if !path.starts_with(fs::canonicalize(root)?) {
                return Err(invalid("Favorite image is outside the favorites directory"));
            }
            let bytes = fs::read(path)?;
            validate_image(&bytes)?;
            Ok(ImageBytes(bytes))
        })
        .transpose()
}

fn validate_image(bytes: &[u8]) -> AppResult<()> {
    image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg)
        .map_err(|e| invalid(format!("Invalid JPEG screenshot: {e}")))?;
    Ok(())
}

fn package_from_conn(
    conn: &Connection,
    state: &AppState,
    scope: &ShareScope,
) -> AppResult<SharePackage> {
    let tx = conn.unchecked_transaction()?;
    let (predicate, parameter): (&str, rusqlite::types::Value) = match scope {
        ShareScope::All => ("1=1", rusqlite::types::Value::Null),
        ShareScope::Map { map } => ("f.map=?1", collection_map(map.clone())?.into()),
        ShareScope::Collection { collection_id } => {
            let map: Option<String> = tx.query_row(
                "SELECT map FROM favorite_collections WHERE id=?1",
                [collection_id],
                |r| r.get(0),
            )?;
            if map.is_none() {
                return Err(invalid("Choose a map for this collection first"));
            }
            ("EXISTS (SELECT 1 FROM favorite_collection_members WHERE favorite_id=f.id AND collection_id=?1)", (*collection_id).into())
        }
    };
    let sql = format!("SELECT f.id, f.snapshot_json, f.saved_at, f.source_label FROM favorites f WHERE {predicate} ORDER BY f.id");
    let mut stmt = tx.prepare(&sql)?;
    let args = if matches!(scope, ShareScope::All) {
        vec![]
    } else {
        vec![parameter]
    };
    let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut favorites = Vec::new();
    let mut favorite_ids = HashMap::new();
    for row in rows {
        let (db_id, json, saved_at, source_label) = row?;
        let snapshot: Snapshot = serde_json::from_str(&json)?;
        let root = favorite_root(state)?;
        let normal_jpg = read_image(&snapshot.detail.screenshot_image_path, &root)?;
        let wide_jpg = read_image(&snapshot.detail.screenshot_wide_image_path, &root)?;
        let id = favorites.len() as u64 + 1;
        favorite_ids.insert(db_id, id);
        // A library source label may be an absolute path on the sender's PC.
        let source_label = if Path::new(&source_label).is_absolute() {
            Path::new(&source_label)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        } else {
            source_label
        };
        favorites.push(SharedFavorite {
            id,
            snapshot: portable_snapshot(&snapshot),
            saved_at,
            source_label,
            normal_jpg,
            wide_jpg,
        });
    }
    let mut collections = Vec::new();
    let mut memberships = Vec::new();
    let mut collection_stmt = tx.prepare(
        "SELECT id, name, map FROM favorite_collections WHERE map IS NOT NULL ORDER BY id",
    )?;
    let selected_collections = collection_stmt
        .query_map([], |row| {
            Ok(FavoriteCollection {
                id: row.get(0)?,
                name: row.get(1)?,
                map: row.get(2)?,
                grenade_count: 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(collection_stmt);
    for c in selected_collections.into_iter().filter(|c| match scope {
        ShareScope::All => c.map.is_some(),
        ShareScope::Map { map } => c.map.as_ref() == Some(map),
        ShareScope::Collection { collection_id } => c.id == *collection_id,
    }) {
        let id = collections.len() as u64 + 1;
        for favorite_id in tx.prepare("SELECT favorite_id FROM favorite_collection_members WHERE collection_id=?1 ORDER BY favorite_id")?.query_map([c.id], |r| r.get::<_, i64>(0))? {
            if let Some(favorite) = favorite_ids.get(&favorite_id?) { memberships.push((id, *favorite)); }
        }
        collections.push(SharedCollection {
            id,
            name: c.name,
            map: c.map.unwrap(),
        });
    }
    drop(stmt);
    tx.commit()?;
    Ok(SharePackage {
        format: FORMAT.into(),
        version: VERSION,
        exported_at: Utc::now().to_rfc3339(),
        favorites,
        collections,
        memberships,
    })
}

fn write_package(path: &Path, package: &SharePackage) -> AppResult<()> {
    let temporary = path.with_extension(format!(
        "msgpack.{}.{}.tmp",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let result = (|| -> AppResult<()> {
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let mut writer = BufWriter::new(file);
        rmp_serde::encode::write_named(&mut writer, package).map_err(|e| invalid(e.to_string()))?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        drop(writer);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
pub(crate) async fn export_favorites_share(
    scope: ShareScope,
    state: tauri::State<'_, AppState>,
) -> AppResult<Option<String>> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_conn(&state)?;
        let label = match &scope {
            ShareScope::All => "all".into(),
            ShareScope::Map { map } => map.clone(),
            ShareScope::Collection { collection_id } => conn.query_row(
                "SELECT name FROM favorite_collections WHERE id=?1",
                [collection_id],
                |r| r.get::<_, String>(0),
            )?,
        };
        let label: String = label
            .chars()
            .map(|c| {
                if c.is_control() || "<>:\"/\\|?*".contains(c) {
                    '_'
                } else {
                    c
                }
            })
            .take(80)
            .collect();
        let name = format!(
            "favorites-{label}-{}.nvshare.msgpack",
            Utc::now().format("%Y-%m-%d")
        );
        let Some(path) = rfd::FileDialog::new()
            .add_filter("Nade Viewer favorites", &["nvshare.msgpack"])
            .set_file_name(name)
            .save_file()
        else {
            return Ok(None);
        };
        let package = package_from_conn(&conn, &state, &scope)?;
        write_package(&path, &package)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| AppError::Message(e.to_string()))?
}

fn validate_package(package: &SharePackage) -> AppResult<()> {
    if package.format != FORMAT {
        return Err(AppError::Import {
            code: "unsupported_share_format",
            message: "Expected a Nade Viewer favorites package".into(),
        });
    }
    if package.version != VERSION {
        return Err(AppError::Import {
            code: "unsupported_share_version",
            message: format!("Unsupported favorites package version {}", package.version),
        });
    }
    let mut favorites = HashMap::new();
    for f in &package.favorites {
        if f.id == 0
            || favorites
                .insert(f.id, f.snapshot.raw.map.as_str())
                .is_some()
        {
            return Err(invalid("Duplicate or invalid favorite ID"));
        }
        let raw = &f.snapshot.raw;
        let detail = &f.snapshot.detail;
        if raw.map.trim().is_empty()
            || raw.map != detail.preview.map
            || raw.side.as_deref().unwrap_or("Any") != detail.preview.side
            || raw.grenade_type.as_deref().unwrap_or("smoke") != detail.preview.grenade_type
        {
            return Err(invalid("Inconsistent favorite snapshot"));
        }
        if chrono::DateTime::parse_from_rfc3339(&f.saved_at).is_err() {
            return Err(invalid("Invalid saved date"));
        }
        for image in [&f.normal_jpg, &f.wide_jpg].into_iter().flatten() {
            validate_image(&image.0)?;
        }
    }
    let mut collections = HashMap::new();
    for c in &package.collections {
        if c.id == 0 || collections.insert(c.id, c.map.as_str()).is_some() {
            return Err(invalid("Duplicate or invalid collection ID"));
        }
        collection_name(c.name.clone())?;
        collection_map(c.map.clone())?;
    }
    for (collection, favorite) in &package.memberships {
        match (collections.get(collection), favorites.get(favorite)) {
            (Some(c), Some(f)) if c == f => (),
            _ => return Err(invalid("Invalid collection membership or map mismatch")),
        }
    }
    Ok(())
}

fn import_package(
    state: &AppState,
    package: SharePackage,
    path: &str,
) -> AppResult<JsonImportReport> {
    validate_package(&package)?;
    let mut conn = open_conn(state)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut incomplete = HashMap::new();
    for row in tx
        .prepare("SELECT id, snapshot_json FROM favorites WHERE identity_key NOT LIKE 'v1:%'")?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
    {
        let (id, json) = row?;
        incomplete
            .entry(portable_identity(&serde_json::from_str(&json)?)?)
            .or_insert(id);
    }
    let mut folders = Vec::new();
    let result = (|| -> AppResult<JsonImportReport> {
        let mut ids = HashMap::new();
        let mut added_count = 0_u64;
        let total = package.favorites.len() as u64;
        let maps = package
            .favorites
            .iter()
            .map(|f| &f.snapshot.raw.map)
            .chain(package.collections.iter().map(|c| &c.map))
            .collect::<HashSet<_>>()
            .len() as u64;
        for (index, favorite) in package.favorites.into_iter().enumerate() {
            manual_import_cancelled(state)?;
            set_status(
                state,
                "importing",
                index as u64,
                total,
                "Importing favorites",
            );
            let key = portable_identity(&favorite.snapshot)?;
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT id FROM favorites WHERE identity_key=?1",
                    [&key],
                    |r| r.get(0),
                )
                .optional()?
                .or_else(|| incomplete.get(&key).copied());
            let id = if let Some(id) = existing {
                id
            } else {
                let mut snapshot = portable_snapshot(&favorite.snapshot);
                let raw = &snapshot.raw;
                let search = [
                    raw.map.as_str(),
                    raw.thrower.as_deref().unwrap_or(""),
                    raw.thrower_team.as_deref().unwrap_or(""),
                    raw.coordinates.as_deref().unwrap_or(""),
                    raw.throw_keys.as_deref().unwrap_or(""),
                    &favorite.source_label,
                ]
                .join(" ")
                .to_lowercase();
                tx.execute("INSERT INTO favorites(identity_key, snapshot_json, map, grenade_type, side, search_text, source_label, saved_at) VALUES (?1, '', ?2, ?3, ?4, ?5, ?6, ?7)", params![key, raw.map, snapshot.detail.preview.grenade_type, snapshot.detail.preview.side, search, favorite.source_label, favorite.saved_at])?;
                let id = tx.last_insert_rowid();
                let folder = favorite_root(state)?.join(id.to_string());
                if favorite.normal_jpg.is_some() || favorite.wide_jpg.is_some() {
                    fs::create_dir_all(favorite_root(state)?)?;
                    // Never overwrite or clean up a directory from another save.
                    fs::create_dir(&folder)?;
                    folders.push(folder.clone());
                }
                for (name, bytes, target) in [
                    (
                        "normal.jpg",
                        favorite.normal_jpg,
                        &mut snapshot.detail.screenshot_image_path,
                    ),
                    (
                        "wide.jpg",
                        favorite.wide_jpg,
                        &mut snapshot.detail.screenshot_wide_image_path,
                    ),
                ] {
                    if let Some(bytes) = bytes {
                        let image_path = folder.join(name);
                        fs::write(&image_path, bytes.0)?;
                        *target = Some(image_path.to_string_lossy().into_owned());
                    }
                }
                snapshot.detail.preview.id = id;
                snapshot.detail.preview.favorite_id = Some(id);
                tx.execute(
                    "UPDATE favorites SET snapshot_json=?1 WHERE id=?2",
                    params![serde_json::to_string(&snapshot)?, id],
                )?;
                match_snapshot(&tx, id, &snapshot.raw, None)?;
                added_count += 1;
                id
            };
            ids.insert(favorite.id, id);
        }
        let mut collection_ids = HashMap::new();
        let collection_count = package.collections.len() as u64;
        let mut added_collections = 0_u64;
        for collection in package.collections {
            manual_import_cancelled(state)?;
            let name = collection_name(collection.name)?;
            let map = collection_map(collection.map)?;
            let existing = tx.query_row("SELECT id FROM favorite_collections WHERE map=?1 AND name=?2 ORDER BY id LIMIT 1", params![map, name], |r| r.get::<_, i64>(0)).optional()?;
            let id = if let Some(id) = existing {
                id
            } else {
                tx.execute(
                    "INSERT INTO favorite_collections(name,map) VALUES (?1,?2)",
                    params![name, map],
                )?;
                added_collections += 1;
                tx.last_insert_rowid()
            };
            collection_ids.insert(collection.id, id);
        }
        for (collection, favorite) in package.memberships {
            manual_import_cancelled(state)?;
            tx.execute("INSERT OR IGNORE INTO favorite_collection_members(collection_id,favorite_id) VALUES (?1,?2)", params![collection_ids[&collection], ids[&favorite]])?;
        }
        manual_import_cancelled(state)?;
        set_status(state, "finalizing", total, total, "Finalizing import");
        tx.commit()?;
        set_status(state, "done", total, total, "Favorites import complete");
        Ok(JsonImportReport::FavoritesShare {
            grenade_count: total,
            map_count: maps,
            added_count,
            reused_count: total - added_count,
            collection_count,
            added_collections,
            merged_collections: collection_count - added_collections,
            source_path: path.into(),
        })
    })();
    if result.is_err() {
        for folder in folders {
            let _ = fs::remove_dir_all(folder);
        }
    }
    result
}

pub(crate) fn import_blocking(state: &AppState, path: &str) -> AppResult<JsonImportReport> {
    manual_import_cancelled(state)?;
    set_status(state, "reading", 0, 0, "Reading import");
    let mut reader = BufReader::new(fs::File::open(path)?);
    let package: SharePackage = rmp_serde::from_read(&mut reader)
        .map_err(|e| invalid(format!("Invalid favorites package: {e}")))?;
    let mut trailing = [0_u8; 1];
    if reader.read(&mut trailing)? != 0 {
        return Err(invalid("Favorites package contains trailing data"));
    }
    import_package(state, package, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::favorites::tests::Fixture;

    fn saved(fixture: &Fixture, complete: bool) -> i64 {
        let (_, source) = fixture.import(7, complete);
        save_from_conn(
            &mut open_conn(&fixture.state).unwrap(),
            &fixture.state,
            source,
        )
        .unwrap()
    }

    fn collection(conn: &Connection, name: &str, map: &str, favorite: Option<i64>) -> i64 {
        conn.execute(
            "INSERT INTO favorite_collections(name,map) VALUES (?1,?2)",
            params![name, map],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        if let Some(favorite) = favorite {
            conn.execute(
                "INSERT INTO favorite_collection_members VALUES (?1,?2)",
                params![id, favorite],
            )
            .unwrap();
        }
        id
    }

    fn package(fixture: &Fixture) -> SharePackage {
        package_from_conn(
            &open_conn(&fixture.state).unwrap(),
            &fixture.state,
            &ShareScope::All,
        )
        .unwrap()
    }

    fn report(value: JsonImportReport) -> Value {
        serde_json::to_value(value).unwrap()
    }

    fn jpg() -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut bytes, image::ImageFormat::Jpeg)
            .unwrap();
        bytes.into_inner()
    }

    #[test]
    fn scopes_include_all_rows_and_preserve_only_selected_collections() {
        let sender = Fixture::new();
        let id = saved(&sender, true);
        let conn = open_conn(&sender.state).unwrap();
        let json: String = conn
            .query_row(
                "SELECT snapshot_json FROM favorites WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        let mut other: Snapshot = serde_json::from_str(&json).unwrap();
        other.raw.map = "de_other".into();
        other.detail.preview.map = "de_other".into();
        let key = portable_identity(&other).unwrap();
        conn.execute("INSERT INTO favorites(identity_key,snapshot_json,map,grenade_type,side,search_text,source_label,saved_at) VALUES (?1,?2,'de_other','smoke','T','','Other',?3)", params![key,serde_json::to_string(&other).unwrap(),Utc::now().to_rfc3339()]).unwrap();
        let other_id = conn.last_insert_rowid();
        // More than the UI's 30/100-row page limits must be exported.
        for n in 0..105 {
            conn.execute("INSERT INTO favorites(identity_key,snapshot_json,map,grenade_type,side,search_text,source_label,saved_at) SELECT ?1,snapshot_json,map,grenade_type,side,search_text,source_label,saved_at FROM favorites WHERE id=?2", params![format!("scope-test-{n}"),id]).unwrap();
        }
        let selected = collection(&conn, "Practice", "de_test", Some(id));
        collection(&conn, "Also", "de_test", Some(id));
        collection(&conn, "Empty", "de_test", None);
        collection(&conn, "Practice", "de_other", Some(other_id));
        conn.execute(
            "INSERT INTO favorite_collections(name,map) VALUES ('Legacy',NULL)",
            [],
        )
        .unwrap();
        let scope = package_from_conn(
            &conn,
            &sender.state,
            &ShareScope::Collection {
                collection_id: selected,
            },
        )
        .unwrap();
        assert_eq!(scope.favorites.len(), 1);
        assert_eq!(scope.collections.len(), 1);
        assert_eq!(scope.memberships, vec![(1, 1)]);
        let scope = package_from_conn(
            &conn,
            &sender.state,
            &ShareScope::Map {
                map: "de_test".into(),
            },
        )
        .unwrap();
        assert_eq!(scope.favorites.len(), 106);
        assert_eq!(scope.collections.len(), 3);
        assert_eq!(scope.memberships.len(), 2);
        let scope = package(&sender);
        assert_eq!(scope.favorites.len(), 107);
        assert_eq!(scope.collections.len(), 4);
        assert_eq!(scope.memberships.len(), 3);
        validate_package(&scope).unwrap();
    }

    #[test]
    fn round_trip_with_binary_images_survives_deleted_libraries_and_repeat_import() {
        let sender = Fixture::new();
        let id = saved(&sender, true);
        let conn = open_conn(&sender.state).unwrap();
        let json: String = conn
            .query_row(
                "SELECT snapshot_json FROM favorites WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        let mut snapshot: Snapshot = serde_json::from_str(&json).unwrap();
        let folder = favorite_root(&sender.state).unwrap().join(id.to_string());
        fs::create_dir_all(&folder).unwrap();
        for (name, target) in [
            ("normal.jpg", &mut snapshot.detail.screenshot_image_path),
            ("wide.jpg", &mut snapshot.detail.screenshot_wide_image_path),
        ] {
            let path = folder.join(name);
            fs::write(&path, jpg()).unwrap();
            *target = Some(path.to_string_lossy().into_owned());
        }
        conn.execute(
            "UPDATE favorites SET snapshot_json=?1,source_label=?2 WHERE id=?3",
            params![
                serde_json::to_string(&snapshot).unwrap(),
                sender.root.join("library.json").to_string_lossy(),
                id
            ],
        )
        .unwrap();
        collection(&conn, "Practice", "de_test", Some(id));
        conn.execute("DELETE FROM imports", []).unwrap();
        let data = package(&sender);
        assert!(data.favorites[0].snapshot.detail.map_image_path.is_none());
        assert!(data.favorites[0]
            .snapshot
            .detail
            .screenshot_image_path
            .is_none());
        assert_eq!(data.favorites[0].source_label, "library.json");
        let path = sender.root.join("roundtrip.nvshare.msgpack");
        write_package(&path, &data).unwrap();
        // Existing export targets are replaced as a complete file.
        write_package(&path, &data).unwrap();
        let recipient = Fixture::new();
        let first =
            report(import_typed_path_blocking(&recipient.state, &path.to_string_lossy()).unwrap());
        assert_eq!(first["kind"], "favorites_share");
        assert_eq!(first["added_count"], 1);
        assert_eq!(first["added_collections"], 1);
        let conn = open_conn(&recipient.state).unwrap();
        assert!(active_import_id(&conn).unwrap().is_none());
        let received = get_favorite_from_conn(&conn, 1).unwrap();
        assert_eq!(
            fs::read(received.detail.screenshot_image_path.as_ref().unwrap()).unwrap(),
            jpg()
        );
        assert_eq!(
            fs::read(received.detail.screenshot_wide_image_path.as_ref().unwrap()).unwrap(),
            jpg()
        );
        assert_eq!(received.saved_at, data.favorites[0].saved_at);
        let before: String = conn
            .query_row("SELECT snapshot_json FROM favorites", [], |r| r.get(0))
            .unwrap();
        let repeated =
            report(import_typed_path_blocking(&recipient.state, &path.to_string_lossy()).unwrap());
        assert_eq!(repeated["added_count"], 0);
        assert_eq!(repeated["reused_count"], 1);
        assert_eq!(repeated["merged_collections"], 1);
        let after: String = conn
            .query_row("SELECT snapshot_json FROM favorites", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(membership(&conn, 1).unwrap().len(), 1);
        recipient.import(2, true);
        assert_eq!(state_from_conn(&conn).unwrap().source_matches.len(), 1);
        let renamed = sender.root.join("renamed.msgpack");
        fs::copy(path, &renamed).unwrap();
        assert_eq!(
            report(
                import_typed_path_blocking(&recipient.state, &renamed.to_string_lossy()).unwrap()
            )["added_count"],
            0
        );
    }

    #[test]
    fn existing_snapshot_is_untouched_and_memberships_are_unioned() {
        let sender = Fixture::new();
        let sender_id = saved(&sender, true);
        let sender_conn = open_conn(&sender.state).unwrap();
        collection(&sender_conn, "Practice", "de_test", Some(sender_id));
        collection(&sender_conn, "New", "de_test", Some(sender_id));
        let recipient = Fixture::new();
        let (_, source) = recipient.import(99, true);
        let mut conn = open_conn(&recipient.state).unwrap();
        let id = save_from_conn(&mut conn, &recipient.state, source).unwrap();
        let existing = collection(&conn, "Practice", "de_test", None);
        let own = collection(&conn, "Mine", "de_test", Some(id));
        collection(&conn, "Practice", "de_other", None);
        let before: String = conn
            .query_row(
                "SELECT snapshot_json FROM favorites WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        let imported = report(import_package(&recipient.state, package(&sender), "test").unwrap());
        assert_eq!(imported["added_count"], 0);
        assert_eq!(imported["merged_collections"], 1);
        assert_eq!(imported["added_collections"], 1);
        assert_eq!(
            get_favorite_from_conn(&conn, id)
                .unwrap()
                .detail
                .preview
                .usage_count,
            99
        );
        assert_eq!(
            conn.query_row(
                "SELECT snapshot_json FROM favorites WHERE id=?1",
                [id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            before
        );
        let members = membership(&conn, id).unwrap();
        assert_eq!(members.len(), 3);
        assert!(members.contains(&own));
        assert!(members.contains(&existing));
    }

    #[test]
    fn incomplete_source_only_favorites_round_trip_without_cross_database_id_matches() {
        let sender = Fixture::new();
        saved(&sender, false);
        let recipient = Fixture::new();
        let local = saved(&recipient, false);
        assert_eq!(
            report(import_package(&recipient.state, package(&sender), "test").unwrap())
                ["added_count"],
            0
        );
        let empty = Fixture::new();
        assert_eq!(
            report(import_package(&empty.state, package(&sender), "test").unwrap())["added_count"],
            1
        );
        assert_eq!(
            report(import_package(&empty.state, package(&sender), "test").unwrap())["added_count"],
            0
        );
        assert_eq!(
            state_from_conn(&open_conn(&recipient.state).unwrap())
                .unwrap()
                .favorites
                .len(),
            1
        );
        assert!(get_favorite_from_conn(&open_conn(&recipient.state).unwrap(), local).is_ok());
    }

    #[test]
    fn corrupt_packages_unknown_versions_and_cross_map_memberships_change_nothing() {
        let sender = Fixture::new();
        saved(&sender, true);
        let recipient = Fixture::new();
        let mut data = package(&sender);
        data.version = 2;
        assert!(matches!(
            import_package(&recipient.state, data, "test"),
            Err(AppError::Import {
                code: "unsupported_share_version",
                ..
            })
        ));
        let mut data = package(&sender);
        data.format = "other".into();
        assert!(matches!(
            import_package(&recipient.state, data, "test"),
            Err(AppError::Import {
                code: "unsupported_share_format",
                ..
            })
        ));
        let mut data = package(&sender);
        data.favorites[0].normal_jpg = Some(ImageBytes(b"broken".to_vec()));
        assert!(import_package(&recipient.state, data, "test").is_err());
        let mut data = package(&sender);
        data.collections.push(SharedCollection {
            id: 1,
            name: "Wrong map".into(),
            map: "de_other".into(),
        });
        data.memberships.push((1, 1));
        assert!(import_package(&recipient.state, data, "test").is_err());
        let path = sender.root.join("trailing.nvshare.msgpack");
        let mut bytes = rmp_serde::to_vec_named(&package(&sender)).unwrap();
        bytes.push(0);
        fs::write(&path, &bytes).unwrap();
        assert!(import_blocking(&recipient.state, &path.to_string_lossy()).is_err());
        fs::write(&path, &bytes[..bytes.len() / 2]).unwrap();
        assert!(import_blocking(&recipient.state, &path.to_string_lossy()).is_err());
        assert!(state_from_conn(&open_conn(&recipient.state).unwrap())
            .unwrap()
            .favorites
            .is_empty());
    }

    #[test]
    fn write_failure_rolls_back_rows_and_only_cleans_its_own_folders() {
        let sender = Fixture::new();
        saved(&sender, true);
        let recipient = Fixture::new();
        let mut data = package(&sender);
        data.favorites[0].normal_jpg = Some(ImageBytes(jpg()));
        let mut second = data.favorites[0].clone();
        second.id = 2;
        second.snapshot.raw.coordinates = Some("setpos 10 20 30".into());
        second.snapshot.detail.preview.coordinates = second.snapshot.raw.coordinates.clone();
        data.favorites.push(second);
        let folder = favorite_root(&recipient.state).unwrap().join("2");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("sentinel"), b"preserve").unwrap();
        assert!(import_package(&recipient.state, data, "test").is_err());
        assert!(state_from_conn(&open_conn(&recipient.state).unwrap())
            .unwrap()
            .favorites
            .is_empty());
        assert!(!favorite_root(&recipient.state).unwrap().join("1").exists());
        assert_eq!(fs::read(folder.join("sentinel")).unwrap(), b"preserve");
        recipient.state.manual_import.begin();
        recipient.state.manual_import.cancel();
        assert!(matches!(
            import_package(&recipient.state, package(&sender), "test"),
            Err(AppError::Import {
                code: "import_cancelled",
                ..
            })
        ));
        assert!(state_from_conn(&open_conn(&recipient.state).unwrap())
            .unwrap()
            .favorites
            .is_empty());
    }
}
