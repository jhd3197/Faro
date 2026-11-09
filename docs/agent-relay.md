# Self-hosted Agent relay

The relay joins outbound connections when machines cannot reach each other
directly. It authenticates each connection using a public-key allowlist. Agent
pairing, peer pins, permissions and revocation still apply end to end. The relay
can observe identities, IP addresses, timing and traffic volume, but cannot read
file contents or commands.

1. Pair the controller and Agent directly first. Keep their existing profiles.
2. Build the relay with `cargo build --release -p faro-agentd --bin faro-relay`
   from `src-tauri`. Copy the binary to your relay machine.
3. Create `allowed-keys.json`, a JSON array of the Agent and controller public
   keys. The Agent key appears in Settings → Remote control. Controller keys
   appear in that Agent's paired-machine list or `faro-agentd info` output.
4. Run `faro-relay 0.0.0.0:8723 relay-identity.json allowed-keys.json`.
   Allow inbound TCP on the chosen port. Keep the generated identity file
   private and persistent. Run under a dedicated service account. Restart the
   relay after changing its allowlist; restarting disconnects existing tunnels.
5. Copy the relay's printed public key and address to Settings → Remote control
   on the Agent. For a headless Agent, put the following `relay.json` beside
   `agentd.json` and restart the service:

   ```json
   { "address": "relay.example.com:8723", "publicKey": "BASE64_RELAY_PUBLIC_KEY" }
   ```

6. Edit the paired connection on the controller and fill in Internet relay's
   address and public key. Save and test the connection. The original direct
   address remains available; clear the relay address to return to direct use.

The Agent replenishes its outbound waiting connection after each controller
arrives and retries after outages. Controllers use their existing reconnect
behavior. A device without a waiting connection reports unavailable. The relay
allows 128 simultaneous sockets and each Agent accepts up to 32 relayed
connections. Registrations expire after 30 seconds; tunnels expire after 24
hours and reconnect on the next operation. Network interruption can still fail
an in-progress operation; never assume a failed write was not applied.

Changing relay settings restarts remote control and disconnects current
sessions. Removing a controller in Remote control revokes its Agent access even
if its relay allowlist entry remains. Remove that entry too when it no longer
needs any relay access. This feature does not provision or publish a service.

Remote control shows whether the configured relay is available or reconnecting,
refreshing its status while the settings panel is open. This reports authenticated
relay registration, not whether a specific controller is currently connected.
