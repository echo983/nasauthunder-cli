# nasauthunder CLI

Archive a local directory to Usenet with your own NNTP account. Files use the same immutable, GCID-addressed 700 KiB article protocol as nasauthunder, and the resulting receipt opens directly in the public browser at `https://<RECEIPT_GCID>.ch13a.com`.

## Requirements

- Node.js 22 or newer
- A Usenet account with posting enabled
- A binary group accepted by the provider

## Install and configure

```bash
npm install -g github:echo983/nasauthunder-cli
nasauthunder config init
chmod 600 ~/.config/nasauthunder/config.json
nasauthunder config check
```

After the npm registry release, `npm install -g nasauthunder-cli` is equivalent.

The password may instead be supplied as `NASAUTHUNDER_NNTP_PASSWORD`. Other fields use the same `NASAUTHUNDER_NNTP_*` prefix.

## Upload

```bash
nasauthunder upload ./my-directory
nasauthunder verify <RECEIPT_GCID>
```

The CLI recursively scans regular files, rejects symbolic links, calculates Thunder GCIDs as streams, uploads continuation articles over persistent concurrent NNTP sessions, and publishes article zero last. A local `.nasauthunder-checkpoint.json` makes interruption recoverable. Re-running against an already committed object validates article zero and skips its upload.

On success:

```text
Receipt GCID: 104CB2...
Open: https://104CB2....ch13a.com
```

## Privacy and responsibility

File contents and paths are posted to the configured Usenet group. Usenet posts are generally immutable and may be publicly retrievable. Use only content you are entitled to distribute. The CLI never sends account credentials to nasauthunder or Cloudflare.

## Protocol

- article payload: 716,800 bytes
- deterministic Message-ID: `<GCID[.index]@nasauthunder-v1.invalid>`
- yEnc with per-article CRC32
- article zero is the final commit marker
- directory metadata: `nasauthunder-receipt-v2`

The receipt's synthetic `source.id` is a deterministic identity for the selected directory manifest. It uses the existing receipt field shape for browser compatibility; it is not a BitTorrent info hash.

Licensed under MIT.
