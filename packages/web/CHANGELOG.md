# Changelog

## 0.5.0

- Both `web_search` and `web_fetch` now use `renderShell: "self"` and
  draw the open-right rounded chrome from
  [`@wierdbytes/pi-common/tool-frame`](../common/README.md#tool-frame)
  for both `renderCall` and `renderResult`. Visual contract matches
  `@wierdbytes/pi-facelift`'s `read` / `bash` / `ls` / `find` / `grep`
  output.
- Body lines render as `│ <content>` with a one-column gap (opt-in
  `paddingX: 1` on the shared frame helpers) so prose and lists read
  cleanly inside the rail.
- Both tools now show a **complete pending box** (top border + body +
  bottom-label) while in flight, with a **live elapsed-time timer**
  in the bottom-label. The timer freezes at the final duration on
  success or error — matching pi-facelift's `bash` chrome. Driven by:
   - a heartbeat `onUpdate({ content: [] })` at the start of
     `execute()` so pi-tui invokes `renderResult` immediately, and
   - a state-machine `setInterval(invalidate, 1000)` set up inside
     the renderer.
- Frame border colour now flips from `warning` (pending) to `success`
  / `error` once the result lands. Previously the top border kept its
  pending colour because pi-tui never re-invoked `renderCall` without
  an `onUpdate` heartbeat.
- `web_search` collapsed result body shows an answer preview (capped
  at 5 lines, with a `... N more lines` overflow indicator); the
  bottom-label now reads
  `<duration> · N sources · M cites · K queries · ctrl+o to expand`.
  Expanded mode keeps the same chrome, drops the expand hint.
- `web_search` error label switches to `<duration> · ✗ <message>` so
  the failure summary travels with the elapsed-time stamp.
- `web_fetch` batch pending-label adds `N/M done` (and `K failed`
  when applicable) alongside the timer; collapsed/expanded success
  labels are `<duration> · <line count> [· ctrl+o to expand]`.
- `web_fetch` batch calls render the URL list as a sub-tree under the
  top border; collapsed results pin the line count + expand hint into
  the bottom-border label slot.
