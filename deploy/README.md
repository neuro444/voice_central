# Voice Central ElevenLabs deployment

From the Mac:

```bash
scp "/Users/sreekanthgopi/Desktop/Maria/Chat_Manager/voice_central_repo/deploy/dist/setup_voice_central_elevenlabs_server.py" root@159.198.44.98:/tmp/setup_voice_central_elevenlabs_server.py
```

On the VPS:

```bash
sudo python3 /tmp/setup_voice_central_elevenlabs_server.py
```

The installer checks the existing restaurant-dashboard service, ElevenLabs orders/handoffs endpoints, and existing staff session configuration. It reads the backend key privately from /opt/elevenlabs_agent/.env. It packages dashboard source files, merges server changes against their Git baselines, and refuses conflicts. It installs dependencies and builds in a staging directory while the existing dashboard runs.

After a successful build it backs up affected files and the staff SQLite database, switches the dashboard build, and starts restaurant-dashboard. It verifies the login page and authenticated ElevenLabs order/handoff proxy responses. A failed switch triggers restoration and login verification. Backups and private build logs are in /opt/voice_central_backups/elevenlabs-<timestamp>.

Only the dashboard service is stopped/started. Nginx and the voice backends are unchanged. Allow a brief dashboard interruption. Success verifies API connectivity, not physical printing or receipt of future post-call webhooks; verify a real call appears in Live Activity and Kitchen afterward.

Regenerate the credential-free bundle after source changes:

```bash
python3 deploy/package_installer.py
python3 -m unittest discover -s deploy/tests -v
```

## Check the deployed integration

The standalone checker performs 17 GET checks: backend health, local/public dashboard login, rejection of missing staff sessions, and backend/local-proxy/public-proxy access for orders, handoffs, costs, and callers. It prints record counts only. It does not install, restart, sync, submit orders, or print tickets. Dashboard requests can produce normal audit log entries.

```bash
scp "/Users/sreekanthgopi/Desktop/Maria/Chat_Manager/voice_central_repo/deploy/check_elevenlabs_integrations.py" root@159.198.44.98:/tmp/check_elevenlabs_integrations.py
```

On the VPS:

```bash
sudo python3 /tmp/check_elevenlabs_integrations.py
```

Exit code 0 means all checks passed; 1 means a check or setup failed. Empty feeds can pass connectivity checks and are explicitly marked. The checker uses the existing backend key and a temporary signed session for an existing staff account without displaying either. No additional Python packages are required. If the service launches through a wrapper and the port cannot be detected, use `--dashboard-url http://127.0.0.1:3002` with the actual dashboard port.

Local checker tests use a temporary loopback HTTP server, including successful empty feeds, upstream authentication errors, redirects, invalid schemas, and session-signature compatibility. They do not contact the VPS.


## Calls & Messages history

The Phone view merges saved ElevenLabs calls with existing Chat Manager history, follows pagination, and displays transcripts and tool turns. Selection uses the existing detail endpoint with a saved-transcript fallback. It does not backfill calls missing from the existing webhook/sync storage.

The installer reads the backend API_KEY privately into ELEVENLABS_CONVERSATIONS_API_KEY, separately from the orders key. No backend deployment is needed. Copy/run the regenerated installer and updated checker using the commands above. The checker additionally tests saved history and the first available transcript through local and public dashboard proxies.
