use faro_agent_proto::{relay::{connect, Registration, RelayConfig}, Auth, Identity, Role, SecureChannel};
use std::{collections::HashSet, time::Duration};

#[tokio::test]
async fn relay_preserves_end_to_end_pins_and_rejects_unknown_identities() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let relay = Identity::generate().unwrap();
        let host = Identity::generate().unwrap();
        let client = Identity::generate().unwrap();
        let unknown = Identity::generate().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = RelayConfig { address: listener.local_addr().unwrap().to_string(), public_key: relay.public_b64().to_string() };
        let allowed = HashSet::from([host.public_b64().to_string(), client.public_b64().to_string()]);
        let task = tokio::spawn(faro_agentd::relay::serve(listener, relay, allowed));
        assert!(connect(&config, &unknown, Registration::Listen).await.is_err());
        let wrong_pin = RelayConfig { public_key: unknown.public_b64().to_string(), ..config.clone() };
        assert!(connect(&wrong_pin, &client, Registration::Connect { target: host.public_b64().into() }).await.is_err());
        let host_config = config.clone();
        let host_key = host.public_b64().to_string();
        let client_pin = client.public_bytes().unwrap();
        let online = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let host_online = online.clone();
        let host_task = tokio::spawn(async move {
            let socket = faro_agent_proto::relay::connect_monitored(&host_config, &host, Registration::Listen, Some(&host_online)).await.unwrap();
            let mut end_to_end = SecureChannel::establish(socket, Role::Responder, &host.private_bytes().unwrap(), Auth::Paired { expect_remote: Some(client_pin) }).await.unwrap();
            assert_eq!(end_to_end.recv::<String>().await.unwrap(), "private payload");
            end_to_end.send(&"received").await.unwrap();
        });
        while !online.load(std::sync::atomic::Ordering::Relaxed) { tokio::time::sleep(Duration::from_millis(10)).await; }
        // Retry until the authenticated host registration has reached the relay.
        let socket = loop {
            match connect(&config, &client, Registration::Connect { target: host_key.clone() }).await {
                Ok(socket) => break socket,
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        };
        let mut end_to_end = SecureChannel::establish(socket, Role::Initiator, &client.private_bytes().unwrap(), Auth::Paired { expect_remote: Some(faro_agent_proto::decode_public(&host_key).unwrap()) }).await.unwrap();
        end_to_end.send(&"private payload").await.unwrap();
        assert_eq!(end_to_end.recv::<String>().await.unwrap(), "received");
        host_task.await.unwrap();
        task.abort();
    }).await.unwrap();
}
