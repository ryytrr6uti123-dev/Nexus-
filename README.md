# Nexus Desktop

A glowing desktop interface with floating browser windows, powered by Electron.
Searches use DuckDuckGo or Bing, and browser windows stay inside Nexus.

## Run locally

1. Install [Node.js](https://nodejs.org/).
2. Run `npm install`.
3. Run `npm start`.

A full-screen browser window opens at startup. The Electron desktop app opens
each browser in a separate native Chromium webview, defined in `browser.html`.
Choose DuckDuckGo or Bing, then search or enter a web address. Links that
request a new window open in another Nexus browser window. To run the hosted
web preview with Scramjet, run `npm run preview` and open the forwarded HTTP
port 4173. GitHub Codespaces is configured to forward this port automatically.
Port 8443 is only for the VPS Caddy/TLS deployment below; it requires the
configured domain and should not be used as the Codespaces preview port. The
preview uses a Scramjet proxy frame so websites are browsed inside Nexus.
To serve it under `/Nexus/IXLearning`, start the preview with
`NEXUS_BASE_PATH=/Nexus/IXLearning npm run preview` and configure the hosting
provider to forward that path to the preview server.

Ad and tracker filtering is enabled in both Electron browser sessions and the
Scramjet preview, using Ghostery's filter engine and filter lists. The Nexus UI
also applies a Content Security Policy that restricts third-party scripts.
Filter lists are downloaded from Ghostery's upstream repository; if they
cannot be loaded, browser windows stay disabled rather than run unprotected.
Ghostery's ad-blocking packages are licensed under MPL-2.0.

The arcade loads 2,500+ HTML5 game listings from the GameMonetize feed. Search
and category filters are available, Recent and Favorites are saved locally,
and Play opens each game in a Nexus browser window rather than a new tab.

Keep the Scramjet preview server private or access-controlled; it provides
outbound website access. Scramjet is distributed under AGPL-3.0-only, so review
its license before distributing Nexus.

Music search uses the Apple iTunes catalog and plays its official previews.
Full-track and licensed lyrics pages open in Nexus's built-in browser.
Playlists, music history, game favorites, game history, and browser searches
save locally for guests and sync to a profile after sign-in. Profile usernames
are unique on the backing Nexus server; account records and hashed passwords
are stored in the app's user-data directory (Electron) or `~/.nexus/profiles.json`
(preview server; override with `NEXUS_DATA_DIR`). Back up and protect that data
directory, and use HTTPS when exposing the preview server so profile cookies
are protected in transit. Movies opens Tubi inside Nexus.

Nexus AI runs a self-hosted Ollama model; prompts are sent to the configured
Ollama instance, not Gemini or another hosted AI API. The default model is
`qwen2.5:3b`. Install Ollama, download the model with `ollama pull qwen2.5:3b`,
then start Nexus with `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`) and
`OLLAMA_MODEL` configured as needed. Each user gets 200 AI questions per UTC
day; one submitted prompt costs one token. Usage is enforced and saved by the
server, separately for signed-in accounts and guest sessions.

The Docker deployment includes a private Ollama service. After starting the
stack, download the default model with
`docker compose exec ollama ollama pull qwen2.5:3b`. The model is stored in the
`ollama_data` Docker volume and is not exposed as a public port. The first model
download can take several gigabytes; inference speed depends on the VPS CPU and
memory.

## Host a private Nexus site on a VPS

The Docker deployment runs Nexus behind Caddy. Caddy obtains HTTPS certificates
for your domain and requires HTTP Basic Authentication before exposing Nexus;
the Scramjet server itself is only available to the private Docker network.

1. Point your domain's DNS `A` record to the VPS IPv4 address. Add an `AAAA`
   record only if the VPS has working IPv6.
2. Install Docker Engine with the Compose plugin on the VPS and allow inbound

built to bypass school filters mostly lightspeed and browse the web!

   TCP ports 80, 443, and 8443 (and UDP 443 for HTTP/3) in its firewall.
3. Clone the repository on the VPS and enter the project directory.
4. Copy `.env.example` to `.env`. Set `NEXUS_DOMAIN` to your domain, and choose
   a long, unique `NEXUS_ACCESS_USER`.
5. Generate a bcrypt password hash using Caddy, then put the hash in
   `NEXUS_ACCESS_PASSWORD_HASH` in `.env`. Do not commit `.env` or share the
   password/hash:

   ```sh
   docker run --rm -it caddy:2-alpine caddy hash-password
   ```

6. Start Nexus:

   ```sh
   docker compose up -d --build
   ```

Open `https://your-domain/Nexus/IXLearning/` or
`https://your-domain:8443/Nexus/IXLearning/` and sign in to the browser's
authentication prompt. Keep the VPS patched and restrict access to people you
trust; this application provides outbound web access through Scramjet. Profile
data is stored in the `nexus_data` Docker volume. Back it up securely before
recreating or migrating the deployment.
