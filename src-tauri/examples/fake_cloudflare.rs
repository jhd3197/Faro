//! Test helper for `cloudflare_api` (issue #57): a stand-in for the Cloudflare
//! API v4, as a stateful in-memory REST store over plain HTTP.
//!
//!   fake_cloudflare --port N --token T [--state FILE] [--seed FILE]
//!
//! Every path under `/client/v4` is a collection or an item: `GET` lists,
//! `POST` creates (with a fresh `id`), `GET|PUT|PATCH|DELETE /<collection>/<id>`
//! read, replace, merge and delete. Replies use Cloudflare's envelope
//! (`{"success","errors","messages","result"}`), and a wrong token gets 403.
//! `--seed` is a JSON object of collection path -> items (accounts, zones);
//! `--state` gets the whole store after every write, for tests to inspect.
//!
//! The few non-REST endpoints Faro calls: `GET /user/tokens/verify`;
//! `GET .../cfd_tunnel/<id>/token`; `.../configurations` and
//! `.../access/apps/<id>/ca`, which are single objects; service tokens and
//! the CA get generated secrets. A tunnel starts `inactive`;
//! `POST /__fake/tunnels/<id>/connect` (what the fake cloudflared's
//! `service install` calls) makes it `healthy`. A CA's key is read from
//! `--ca-pub` when given, so certificates the test signs are trusted.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

type Store = BTreeMap<String, Vec<Value>>;

struct Fake {
    token: String,
    store: Mutex<Store>,
    state_file: Option<String>,
    ca_pub: Option<String>,
    counter: Mutex<u64>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let port = flag("--port").unwrap_or_else(|| "0".into());
    let mut store: Store = BTreeMap::new();
    if let Some(seed) = flag("--seed") {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(seed).unwrap()).unwrap();
        for (k, items) in v.as_object().unwrap() {
            store.insert(k.trim_matches('/').to_string(), items.as_array().unwrap().clone());
        }
    }
    let fake = Arc::new(Fake {
        token: flag("--token").unwrap_or_else(|| "test-token".into()),
        store: Mutex::new(store),
        state_file: flag("--state"),
        ca_pub: flag("--ca-pub").map(|p| std::fs::read_to_string(p).unwrap().trim().to_string()),
        counter: Mutex::new(0),
    });
    fake.save();
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
    // The test reads the bound port from the first line.
    println!("listening http://{}", listener.local_addr().unwrap());
    std::io::stdout().flush().unwrap();
    for stream in listener.incoming().flatten() {
        let fake = fake.clone();
        std::thread::spawn(move || {
            let _ = serve(&fake, stream);
        });
    }
}

impl Fake {
    fn next_id(&self) -> String {
        let mut c = self.counter.lock().unwrap();
        *c += 1;
        format!("{:032x}", 0xfa20_0000_u64 + *c)
    }

    fn save(&self) {
        if let Some(path) = &self.state_file {
            let store = self.store.lock().unwrap();
            let _ = std::fs::write(path, serde_json::to_vec_pretty(&*store).unwrap());
        }
    }
}

fn serve(fake: &Fake, mut stream: TcpStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut len = 0usize;
    let mut auth = String::new();
    loop {
        let mut h = String::new();
        reader.read_line(&mut h)?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "content-length" => len = v.trim().parse().unwrap_or(0),
                "authorization" => auth = v.trim().to_string(),
                _ => {}
            }
        }
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let (status, reply) = handle(fake, &method, path, query, &auth, body);
    let bytes = serde_json::to_vec(&reply).unwrap();
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    )?;
    stream.write_all(&bytes)
}

fn ok(result: Value) -> (&'static str, Value) {
    ("200 OK", json!({ "success": true, "errors": [], "messages": [], "result": result }))
}

fn fail(status: &'static str, code: u32, message: &str) -> (&'static str, Value) {
    (status, json!({ "success": false, "errors": [{ "code": code, "message": message }], "messages": [], "result": null }))
}

fn handle(fake: &Fake, method: &str, path: &str, query: &str, auth: &str, body: Value) -> (&'static str, Value) {
    // Test-only: a tunnel's connector came up.
    if let Some(id) = path.strip_prefix("/__fake/tunnels/").and_then(|p| p.strip_suffix("/connect")) {
        let mut store = fake.store.lock().unwrap();
        for (k, items) in store.iter_mut() {
            if k.ends_with("/cfd_tunnel") {
                for t in items.iter_mut().filter(|t| t["id"] == id) {
                    t["status"] = "healthy".into();
                    t["conns_active_at"] = "2099-01-01T00:00:00Z".into();
                }
            }
        }
        drop(store);
        fake.save();
        return ok(json!({}));
    }
    let Some(path) = path.strip_prefix("/client/v4/") else {
        return fail("404 Not Found", 7000, "No route for that URI");
    };
    if auth != format!("Bearer {}", fake.token) {
        return fail("403 Forbidden", 10000, "Authentication error");
    }
    let path = path.trim_matches('/');
    if path == "user/tokens/verify" {
        return ok(json!({ "id": "tok", "status": "active" }));
    }
    let segs: Vec<&str> = path.split('/').collect();
    // Tunnel run token.
    if segs.len() == 5 && segs[2] == "cfd_tunnel" && segs[4] == "token" {
        return ok(Value::String(format!("tunnel-token-{}", segs[3])));
    }
    // Single objects: a tunnel's configuration, an Access app's SSH CA.
    let single = (segs.len() == 5 && segs[2] == "cfd_tunnel" && segs[4] == "configurations")
        || (segs.len() == 6 && segs[2] == "access" && segs[3] == "apps" && segs[5] == "ca");
    if single {
        let mut store = fake.store.lock().unwrap();
        let slot = store.entry(path.to_string()).or_default();
        let reply = match method {
            "GET" if slot.is_empty() => fail("404 Not Found", 1003, "not found"),
            "GET" => ok(slot[0].clone()),
            "DELETE" => {
                slot.clear();
                ok(json!({}))
            }
            _ => {
                let mut v = if segs[5..].first() == Some(&"ca") {
                    if !slot.is_empty() {
                        return fail("400 Bad Request", 12130, "access.api.error.certificate_already_exists");
                    }
                    let key = fake.ca_pub.clone().unwrap_or_else(|| "ecdsa-sha2-nistp256 AAAAfake open-ssh-ca@cloudflareaccess.org".into());
                    json!({ "id": fake.next_id(), "aud": segs[4], "public_key": key })
                } else {
                    body
                };
                if v.get("tunnel_id").is_none() && segs[2] == "cfd_tunnel" {
                    v["tunnel_id"] = segs[3].into();
                }
                slot.clear();
                slot.push(v.clone());
                ok(v)
            }
        };
        drop(store);
        fake.save();
        return reply;
    }
    // Plain REST: an even number of segments past the root names an item
    // when the last one is a known id in its collection.
    let mut store = fake.store.lock().unwrap();
    let (collection, id) = match segs.split_last() {
        Some((last, rest)) if !rest.is_empty() && store.get(&rest.join("/")).is_some_and(|c| c.iter().any(|i| i["id"] == *last)) => {
            (rest.join("/"), Some(last.to_string()))
        }
        _ => (path.to_string(), None),
    };
    let reply = match (method, id) {
        ("GET", None) => {
            let items = store.get(&collection).cloned().unwrap_or_default();
            // Filters Faro uses: `name=`, `account.id=` and `is_deleted=false`.
            let items: Vec<Value> = items
                .into_iter()
                .filter(|i| {
                    query.split('&').all(|q| match q.split_once('=') {
                        Some(("name", v)) => i["name"] == v,
                        Some(("account.id", v)) => i["account"]["id"] == v,
                        Some(("is_deleted", "false")) => i.get("deleted_at").map_or(true, Value::is_null),
                        _ => true,
                    })
                })
                .collect();
            ok(Value::Array(items))
        }
        ("POST", None) => {
            let mut item = body;
            let id = fake.next_id();
            item["id"] = id.clone().into();
            if collection.ends_with("access/service_tokens") {
                item["client_id"] = format!("{id}.access").into();
                item["client_secret"] = format!("secret-{id}").into();
            }
            if collection.ends_with("/cfd_tunnel") {
                item["status"] = "inactive".into();
            }
            if collection.ends_with("access/apps") {
                item["aud"] = format!("aud-{id}").into();
            }
            store.entry(collection).or_default().push(item.clone());
            // Cloudflare never returns a service token's secret again.
            ok(item)
        }
        ("GET", Some(id)) => ok(store[&collection].iter().find(|i| i["id"] == id).cloned().unwrap()),
        ("PUT" | "PATCH", Some(id)) => {
            let item = store.get_mut(&collection).unwrap().iter_mut().find(|i| i["id"] == id).unwrap();
            if method == "PUT" {
                let mut next = body;
                next["id"] = id.into();
                *item = next;
            } else if let (Some(obj), Some(patch)) = (item.as_object_mut(), body.as_object()) {
                for (k, v) in patch {
                    obj.insert(k.clone(), v.clone());
                }
            }
            ok(item.clone())
        }
        ("DELETE", Some(id)) => {
            let items = store.get_mut(&collection).unwrap();
            items.retain(|i| i["id"] != id);
            ok(json!({ "id": id }))
        }
        _ => fail("404 Not Found", 7003, "Could not route to that path"),
    };
    drop(store);
    if method != "GET" {
        fake.save();
    }
    reply
}
