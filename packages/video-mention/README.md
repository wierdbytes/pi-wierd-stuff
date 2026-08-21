# @wierdbytes/pi-video-mention

Attach video files to pi prompts with `@` mentions and let the agent actually
*see* them — but only when the active model really supports video input.

```
what happens in this clip? @demo.mp4
compare @take-one.mov with @take-two.mov
```

## How it works

1. **On input** every `@mention` pointing at a video file (`.mp4`, `.webm`,
   `.mov`, `.mkv`, `.avi`, `.wmv`, `.flv`, `.mpg`, `.mpeg`, `.m4v`, `.3gp`,
   `.ogv`, `.ts`) that exists, is non-empty and under the size cap is
   rewritten into an internal marker.

2. **On every provider request** (the marker rides along in the message
   history, so the decision follows model switches mid-session) the active
   model is checked for video support, in order:

   - `PI_VIDEO_MENTION_MODELS` — comma-separated `provider/model` glob
     patterns that force video support (`openrouter/stealth/*`, …);
   - the pi model registry — model's `input` list contains `"video"`;
   - for OpenRouter-baseUrl models — a single probe of the public
     `/api/v1/models` catalogue per process: any model whose
     `architecture.input_modalities` includes `"video"` qualifies.

   If supported *and* the model uses the `openai-completions` wire format,
   the marker becomes a base64 data-URL content part:

     ```json
     { "type": "video_url", "video_url": { "url": "data:video/mp4;base64,..." } }
     ```

     This is the shape OpenRouter documents for video input
     (`stealth/ox-alpha`, Gemini, Grok, …).

   - **Anything else** — no model, no `"video"` in `input`, different API,
     unreadable file → the marker degrades back to the plain `@path`
     mention. Nothing breaks; the agent can still open the file with its
     read tool.

Run `/video-mention` to check whether the active model supports video.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_VIDEO_MENTION_MAX_MB` | `100` | Max attachment size in MB. Larger mentions stay plain text (base64 lives in memory). |
| `PI_VIDEO_MENTION_MODELS` | — | Comma-separated `provider/model` globs forced video-capable, e.g. `openrouter/stealth/*`. |

## Local development install

**One-off test:**

```bash
pi -e ~/me/dev/pi-wierd-stuff/packages/video-mention/index.ts
```

**Global (all projects)** — add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "~/me/dev/pi-wierd-stuff/packages/video-mention"
  ]
}
```

(or symlink it into `~/.pi/agent/extensions/`).

**Project-local** — from the project root:

```bash
mkdir -p .pi/extensions
ln -s ~/me/dev/pi-wierd-stuff/packages/video-mention .
```

No runtime dependencies; only devDependencies for typechecking.

## Notes

- The whole file is base64-encoded into the request (~+33 % size), so very
  large videos are better hosted and referenced by URL instead.
- pi normalizes catalogued modalities to `text`/`image`, so registry-based
  detection usually needs a `modelOverrides` entry in
  `~/.pi/agent/models.json`:

  ```json
  {
    "providers": {
      "openrouter": {
        "modelOverrides": {
          "stealth/ox-alpha": { "input": ["text", "image", "video"] }
        }
      }
    }
  }
  ```

  For OpenRouter models the extension works without this thanks to the
  catalogue probe; other providers may need the override or the env var.
