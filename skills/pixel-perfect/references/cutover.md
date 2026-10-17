# Cutover

`/pixel-perfect cutover` gets a finished clone ready to replace the live site. Run it only when the user asks for cutover by name on a project that already has a passing clone. It never deploys: it prepares the code and the user ships it.

Cutover makes three changes: it removes the `noindex` tag, wires the forms to a service the user picks, and adds back the third-party scripts the user chooses. Each one turns off a pre-cutover safeguard, so each needs the user's say-so.

## Ask once

Gather everything in one numbered message, then wait:

1. Forms: which service, or their own endpoint. Offer the common ones (Formspree, Basin, a `mailto:`, or a POST URL they give). One answer covers every form unless they say otherwise.
2. Scripts: read the list of third-party scripts from the report and ask which to add back. Analytics and chat are the usual yes; trackers are often no. Default to none.
3. Go-live path: confirm the page keeps the same path, and ask for the production URL so the canonical and `metadataBase` can point at it instead of the original.

Do not ask one question at a time. Do not deploy, push or change DNS at any point.

## Make the changes

1. Remove `noindex`: delete `robots: { index: false }` from each page's metadata. Set `alternates.canonical` and `metadataBase` to the production URL from the user, since those pointed at the original until now.
2. Wire the forms: replace the inert `onSubmit` from references/stack.md with a submit to the chosen service. Keep the native validation. Set `action` and `method` again if the service wants a plain POST. Remove the `data-pp-form="inert"` marker once a form sends. Show a real success and error state.
3. Add back scripts: load each chosen script with `next/script`, not a raw `<script>` tag, so Next controls when it runs. Use `strategy="afterInteractive"` for analytics and chat. Leave out every script the user did not pick.

## Record and rebuild

Write `.pixel-perfect/cutover.json`:

```json
{ "done": true, "date": "<today>", "forms": "formspree", "scripts": ["plausible"] }
```

Then run a build to confirm the project still compiles, and regenerate the report so it shows the cutover as done:

```bash
node "$PP/report.mjs" --cutover .pixel-perfect/cutover.json
```

## Report back

Tell the user, briefly:

1. What changed: noindex removed, forms wired to `<service>`, scripts added back.
2. Internal links that point at pages this project does not have yet. A one-page clone keeps its `/pricing` and `/about` links as-is; list them so the user knows which pages still need cloning or routing before go-live.
3. That the code is ready and they deploy it themselves. The skill does not deploy.
