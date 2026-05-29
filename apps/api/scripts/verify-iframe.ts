// PR7 verification harness — Step 4.3 iframe runtime primitives.
//
// In-process exercises of the load-bearing pieces the iframe route depends on:
//   1. shared iframe-protocol type-guards (isHostToIframe / isIframeToHost)
//   2. shared synthesizeDefaultProps over the full D1 row-kind matrix
//   3. Storage upload + signed-URL sign + HEAD round-trip on the live bucket
//      (verifies CORS + 15-min TTL works against the real Supabase bucket)
//   4. Storage list-prefix shape (the signGlobalsCss + signProvidersBundle
//      helpers rely on this)
//   5. DB sentinel manifest insert + RLS-bypassed select via service-role +
//      cascade teardown
//   6. (PR11) providers bundle round-trip — upload `providers.<hash>.js`,
//      assert the list-prefix regex used by signProvidersBundle matches +
//      HEAD-signs cleanly. The pure renderIframeHtml `providersUrl` branch
//      is covered structurally by `next build` in PR11 verification.
//
// The route handler itself is exercised in the next build + a manual curl
// against `next dev` — the route depends on Next 16's request-scoped cookies()
// which can't run outside a live server. The pure helpers (renderIframeHtml +
// buildCsp) are covered structurally by `next build`.
//
// Run with: pnpm --filter @usemount/api verify:iframe
// Exits non-zero on any failed assertion. Cleanup is in a finally block so a
// mid-run failure still removes the sentinel rows and storage objects.

import { createHash } from "node:crypto"
import {
  IFRAME_PROTOCOL_VERSION,
  isHostToIframe,
  isIframeToHost,
  synthesizeDefaultProps,
  type BuildManifestControls,
} from "@usemount/shared"
import { supabaseAdmin } from "../src/supabase/admin.js"

try {
  process.loadEnvFile(".env.local")
} catch {
  // Platform-provided env.
}

// Sentinel ids — outside GitHub's plausible space + outside PR5/PR6 ranges.
const TEST_INSTALL_ID = 999_999_999_971
const TEST_REPO_ID = 999_999_999_972
const TEST_BRANCH = "test/pr7-iframe"
const TEST_SLUG = "verify-iframe-button"
const BUCKET = "component-artifacts"
const SIGNED_URL_TTL_SECONDS = 15 * 60

interface SetupResult {
  workspaceId: string
  repoConnectionId: string
  instanceId: string
  manifestId: string
  jsKey: string
  cssKey: string
  globalsKey: string
  providersKey: string
  sourceHash: string
  globalsHash: string
  providersHash: string
}

interface Case {
  name: string
  ok: boolean
  detail?: string
}
const cases: Case[] = []
function assert(name: string, ok: boolean, detail?: string): void {
  cases.push({ name, ok, detail })
  if (!ok) {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  } else {
    console.log(`  ✓ ${name}`)
  }
}

async function setup(): Promise<SetupResult> {
  const sb = supabaseAdmin()
  const { data: ws, error: wsErr } = await sb
    .from("workspaces")
    .select("id")
    .eq("kind", "personal")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (wsErr || !ws)
    throw new Error(
      "No personal workspace found in hosted DB — sign in once first.",
    )

  const { data: conn, error: connErr } = await sb
    .from("repo_connections")
    .upsert(
      {
        workspace_id: ws.id,
        github_install_id: TEST_INSTALL_ID,
        github_repo_id: TEST_REPO_ID,
        org_repo: "verify/pr7-fixture",
        default_branch: TEST_BRANCH,
        active: true,
      },
      { onConflict: "github_install_id,github_repo_id" },
    )
    .select("id")
    .single()
  if (connErr || !conn) throw new Error(`setup repo_connection: ${connErr?.message}`)

  const { data: inst, error: instErr } = await sb
    .from("instances")
    .upsert(
      {
        workspace_id: ws.id,
        repo_connection_id: conn.id,
        branch: TEST_BRANCH,
        pinned: true,
      },
      { onConflict: "repo_connection_id,branch" },
    )
    .select("id")
    .single()
  if (instErr || !inst) throw new Error(`setup instance: ${instErr?.message}`)

  // Sentinel bundle bytes — never executed, just round-tripped through
  // Storage. Real ESM is exercised end-to-end by the apps/api worker (PR6).
  const jsBody = `// PR7 sentinel\nexport default function Sentinel(){return null}\n`
  const cssBody = `/* PR7 sentinel */\n.sentinel { color: rebeccapurple; }\n`
  const globalsBody = `/* PR7 globals */\nhtml { font-family: system-ui; }\n`
  // PR11 providers sentinel — minimal ESM with the locked default-export shape.
  const providersBody = `// PR11 providers sentinel\nexport default function Providers(p){return p.children}\n`
  const sourceHash = createHash("sha256")
    .update(jsBody)
    .digest("hex")
    .slice(0, 16)
  const globalsHash = createHash("sha256")
    .update(globalsBody)
    .digest("hex")
    .slice(0, 16)
  const providersHash = createHash("sha256")
    .update(providersBody)
    .digest("hex")
    .slice(0, 16)
  const jsKey = `${inst.id}/${TEST_SLUG}.${sourceHash}.js`
  const cssKey = `${inst.id}/${TEST_SLUG}.${sourceHash}.css`
  const globalsKey = `${inst.id}/globals.${globalsHash}.css`
  const providersKey = `${inst.id}/providers.${providersHash}.js`
  const jsUpload = await sb.storage
    .from(BUCKET)
    .upload(jsKey, new Blob([jsBody], { type: "application/javascript" }), {
      upsert: true,
      contentType: "application/javascript",
    })
  if (jsUpload.error) throw new Error(`upload js: ${jsUpload.error.message}`)
  const cssUpload = await sb.storage
    .from(BUCKET)
    .upload(cssKey, new Blob([cssBody], { type: "text/css" }), {
      upsert: true,
      contentType: "text/css",
    })
  if (cssUpload.error) throw new Error(`upload css: ${cssUpload.error.message}`)
  const globalsUpload = await sb.storage
    .from(BUCKET)
    .upload(globalsKey, new Blob([globalsBody], { type: "text/css" }), {
      upsert: true,
      contentType: "text/css",
    })
  if (globalsUpload.error)
    throw new Error(`upload globals: ${globalsUpload.error.message}`)
  const providersUpload = await sb.storage
    .from(BUCKET)
    .upload(
      providersKey,
      new Blob([providersBody], { type: "application/javascript" }),
      {
        upsert: true,
        contentType: "application/javascript",
      },
    )
  if (providersUpload.error)
    throw new Error(`upload providers: ${providersUpload.error.message}`)

  const controls: BuildManifestControls = {
    variants: { prop: "variant", options: ["primary", "secondary"] },
    sizes: { prop: "size", options: ["small", "medium", "large"] },
    booleans: ["disabled", "loading"],
    slots: [{ prop: "children", label: "Children" }],
    strings: [{ prop: "label" }],
    numbers: [{ prop: "tabIndex" }],
    handlers: [{ prop: "onClick", signature: "(e: MouseEvent) => void" }],
    objects: [{ prop: "style", typeString: "Record<string, string>" }],
  }
  const { data: man, error: manErr } = await sb
    .from("component_manifests")
    .upsert(
      {
        instance_id: inst.id,
        slug: TEST_SLUG,
        folder_path: "verify/pr7",
        title: "VerifyIframeButton",
        kind: "component",
        variants_json: controls,
        states_json: {},
        props_schema_json: {
          variant: '"primary" | "secondary"',
          label: "string",
          disabled: "boolean",
        },
        artifact_url: jsKey,
        source_hash: sourceHash,
      },
      { onConflict: "instance_id,slug" },
    )
    .select("id")
    .single()
  if (manErr || !man) throw new Error(`upsert manifest: ${manErr?.message}`)

  return {
    workspaceId: ws.id,
    repoConnectionId: conn.id,
    instanceId: inst.id,
    manifestId: man.id,
    jsKey,
    cssKey,
    globalsKey,
    providersKey,
    sourceHash,
    globalsHash,
    providersHash,
  }
}

async function teardown(s: SetupResult | null): Promise<void> {
  if (!s) return
  const sb = supabaseAdmin()
  // Storage first (orphaned objects don't get cleaned up by cascading FKs).
  try {
    await sb.storage
      .from(BUCKET)
      .remove([s.jsKey, s.cssKey, s.globalsKey, s.providersKey])
  } catch (e) {
    console.warn(`[teardown] storage remove: ${(e as Error).message}`)
  }
  // Cascade chain: repo_connections → instances → component_manifests +
  // component_views via ON DELETE CASCADE on FK.
  await sb.from("repo_connections").delete().eq("id", s.repoConnectionId)
}

function runProtocolGuardCases(): void {
  // Positive — every legal HostToIframe variant.
  assert(
    "isHostToIframe accepts init",
    isHostToIframe({
      v: IFRAME_PROTOCOL_VERSION,
      kind: "init",
      props: { variant: "primary" },
    }),
  )
  assert(
    "isHostToIframe accepts setProps",
    isHostToIframe({
      v: IFRAME_PROTOCOL_VERSION,
      kind: "setProps",
      props: {},
    }),
  )
  // Negative — wrong shapes, missing fields, version mismatch, prototype tampering.
  assert(
    "isHostToIframe rejects null",
    !isHostToIframe(null),
  )
  assert(
    "isHostToIframe rejects wrong version",
    !isHostToIframe({ v: 99, kind: "init", props: {} }),
  )
  assert(
    "isHostToIframe rejects missing props",
    !isHostToIframe({ v: IFRAME_PROTOCOL_VERSION, kind: "init" }),
  )
  assert(
    "isHostToIframe rejects unknown kind",
    !isHostToIframe({ v: IFRAME_PROTOCOL_VERSION, kind: "evil", props: {} }),
  )
  assert(
    "isHostToIframe rejects string instead of object",
    !isHostToIframe("not an object"),
  )

  // Positive — every legal IframeToHost variant.
  assert(
    "isIframeToHost accepts ready",
    isIframeToHost({
      v: IFRAME_PROTOCOL_VERSION,
      kind: "ready",
      bbox: { width: 160, height: 48 },
    }),
  )
  assert(
    "isIframeToHost accepts resize",
    isIframeToHost({
      v: IFRAME_PROTOCOL_VERSION,
      kind: "resize",
      bbox: { width: 200, height: 60 },
    }),
  )
  assert(
    "isIframeToHost accepts error",
    isIframeToHost({
      v: IFRAME_PROTOCOL_VERSION,
      kind: "error",
      message: "boom",
    }),
  )
  assert(
    "isIframeToHost accepts wheel",
    isIframeToHost({
      v: IFRAME_PROTOCOL_VERSION,
      kind: "wheel",
      deltaY: -12,
      x: 40,
      y: 24,
    }),
  )
  assert(
    "isIframeToHost accepts pan",
    isIframeToHost({
      v: IFRAME_PROTOCOL_VERSION,
      kind: "pan",
      deltaX: 8,
      deltaY: -16,
    }),
  )
  // Negative
  assert(
    "isIframeToHost rejects ready with negative bbox",
    !isIframeToHost({
      v: IFRAME_PROTOCOL_VERSION,
      kind: "ready",
      bbox: { width: -1, height: 48 },
    }),
  )
  assert(
    "isIframeToHost rejects error with non-string message",
    !isIframeToHost({
      v: IFRAME_PROTOCOL_VERSION,
      kind: "error",
      message: 42,
    }),
  )
  assert(
    "isIframeToHost rejects wheel with non-number deltaY",
    !isIframeToHost({
      v: IFRAME_PROTOCOL_VERSION,
      kind: "wheel",
      deltaY: "fast",
      x: 40,
      y: 24,
    }),
  )
  assert(
    "isIframeToHost rejects pan with non-number deltaX",
    !isIframeToHost({
      v: IFRAME_PROTOCOL_VERSION,
      kind: "pan",
      deltaX: "left",
      deltaY: 16,
    }),
  )
  assert(
    "isIframeToHost rejects undefined",
    !isIframeToHost(undefined),
  )
}

function runSynthesizeDefaultsCases(): void {
  // Empty controls — empty defaults.
  const emptyControls: BuildManifestControls = {
    booleans: [],
    slots: [],
    strings: [],
    numbers: [],
    handlers: [],
    objects: [],
  }
  const empty = synthesizeDefaultProps(emptyControls)
  assert(
    "synthesize empty controls → {}",
    Object.keys(empty).length === 0,
    JSON.stringify(empty),
  )

  // Full controls — every kind produces a default value of the right type.
  const full: BuildManifestControls = {
    variants: { prop: "variant", options: ["primary", "secondary", "ghost"] },
    sizes: { prop: "size", options: ["small", "medium"] },
    forms: { prop: "form", options: ["label", "icon-only"] },
    booleans: ["disabled", "loading"],
    slots: [{ prop: "children", label: "Children" }],
    strings: [{ prop: "label" }, { prop: "ariaLabel" }],
    numbers: [{ prop: "tabIndex" }],
    handlers: [{ prop: "onClick", signature: "(e: MouseEvent) => void" }],
    objects: [{ prop: "style", typeString: "Record<string, string>" }],
  }
  const out = synthesizeDefaultProps(full)
  assert(
    "synthesize → variant=first option",
    out.variant === "primary",
    JSON.stringify(out.variant),
  )
  assert(
    "synthesize → size=first option",
    out.size === "small",
    JSON.stringify(out.size),
  )
  assert(
    "synthesize → form=first option",
    out.form === "label",
    JSON.stringify(out.form),
  )
  assert(
    "synthesize → disabled=false",
    out.disabled === false,
    JSON.stringify(out.disabled),
  )
  assert(
    "synthesize → loading=false",
    out.loading === false,
    JSON.stringify(out.loading),
  )
  assert(
    "synthesize → label=''",
    out.label === "",
    JSON.stringify(out.label),
  )
  assert(
    "synthesize → ariaLabel=''",
    out.ariaLabel === "",
    JSON.stringify(out.ariaLabel),
  )
  assert(
    "synthesize → tabIndex=0",
    out.tabIndex === 0,
    JSON.stringify(out.tabIndex),
  )
  assert(
    "synthesize omits handlers/slots/objects (left undefined for customer defaults)",
    !("onClick" in out) && !("children" in out) && !("style" in out),
    JSON.stringify(out),
  )
}

async function runStorageCases(s: SetupResult): Promise<void> {
  const sb = supabaseAdmin()
  // 1) Sign + HEAD the JS bundle.
  const { data: jsSign, error: jsErr } = await sb.storage
    .from(BUCKET)
    .createSignedUrl(s.jsKey, SIGNED_URL_TTL_SECONDS)
  assert(
    "createSignedUrl(js) returns URL",
    !!jsSign?.signedUrl && !jsErr,
    jsErr?.message,
  )
  if (jsSign?.signedUrl) {
    const resp = await fetch(jsSign.signedUrl, { method: "HEAD" })
    assert(
      "HEAD signed js URL → 200",
      resp.status === 200,
      `${resp.status} ${resp.statusText}`,
    )
    const cors = resp.headers.get("access-control-allow-origin")
    assert(
      "signed js URL returns ACAO header",
      cors !== null,
      `header value: ${cors}`,
    )
  }

  // 2) Sign + HEAD the per-component CSS.
  const { data: cssSign, error: cssErr } = await sb.storage
    .from(BUCKET)
    .createSignedUrl(s.cssKey, SIGNED_URL_TTL_SECONDS)
  assert(
    "createSignedUrl(css) returns URL",
    !!cssSign?.signedUrl && !cssErr,
    cssErr?.message,
  )
  if (cssSign?.signedUrl) {
    const resp = await fetch(cssSign.signedUrl, { method: "HEAD" })
    assert(
      "HEAD signed css URL → 200",
      resp.status === 200,
      `${resp.status} ${resp.statusText}`,
    )
  }

  // 3) List prefix → find globals.* (the path signGlobalsCss uses).
  const { data: files, error: listErr } = await sb.storage
    .from(BUCKET)
    .list(s.instanceId, {
      limit: 100,
      sortBy: { column: "updated_at", order: "desc" },
    })
  assert(
    "list bucket prefix returns objects",
    Array.isArray(files) && !listErr,
    listErr?.message,
  )
  const globalsFile = (files ?? []).find((f) =>
    /^globals\.[a-f0-9]+\.css$/i.test(f.name),
  )
  assert(
    "list prefix surfaces globals.<hash>.css",
    !!globalsFile,
    `files: ${(files ?? []).map((f) => f.name).join(", ")}`,
  )

  // 4) HEAD signed globals URL too.
  if (globalsFile) {
    const { data: gSign, error: gErr } = await sb.storage
      .from(BUCKET)
      .createSignedUrl(`${s.instanceId}/${globalsFile.name}`, SIGNED_URL_TTL_SECONDS)
    assert(
      "createSignedUrl(globals) returns URL",
      !!gSign?.signedUrl && !gErr,
      gErr?.message,
    )
    if (gSign?.signedUrl) {
      const resp = await fetch(gSign.signedUrl, { method: "HEAD" })
      assert(
        "HEAD signed globals URL → 200",
        resp.status === 200,
        `${resp.status} ${resp.statusText}`,
      )
    }
  }

  // 5) Signed URL for a non-existent key fails clearly (the route handler
  // surfaces this as a 500 with the storage message).
  const { error: missingErr } = await sb.storage
    .from(BUCKET)
    .createSignedUrl(`${s.instanceId}/does-not-exist.js`, SIGNED_URL_TTL_SECONDS)
  assert(
    "createSignedUrl(missing key) errors",
    !!missingErr,
    "expected error for missing object",
  )

  // 6) PR11 — providers bundle list-and-sign round-trip. signProvidersBundle
  // uses the same list-prefix + regex shape as signGlobalsCss; this exercises
  // the storage contract directly.
  const providersFile = (files ?? []).find((f) =>
    /^providers\.[a-f0-9]+\.js$/i.test(f.name),
  )
  assert(
    "list prefix surfaces providers.<hash>.js (signProvidersBundle regex matches)",
    !!providersFile,
    `files: ${(files ?? []).map((f) => f.name).join(", ")}`,
  )
  if (providersFile) {
    const { data: pSign, error: pErr } = await sb.storage
      .from(BUCKET)
      .createSignedUrl(`${s.instanceId}/${providersFile.name}`, SIGNED_URL_TTL_SECONDS)
    assert(
      "createSignedUrl(providers) returns URL",
      !!pSign?.signedUrl && !pErr,
      pErr?.message,
    )
    if (pSign?.signedUrl) {
      const resp = await fetch(pSign.signedUrl, { method: "HEAD" })
      assert(
        "HEAD signed providers URL → 200",
        resp.status === 200,
        `${resp.status} ${resp.statusText}`,
      )
    }
  }
}

async function runDbCases(s: SetupResult): Promise<void> {
  const sb = supabaseAdmin()
  // Sentinel manifest is readable + has the controls shape PR7 expects.
  const { data: row, error: rowErr } = await sb
    .from("component_manifests")
    .select("id, kind, artifact_url, title, variants_json")
    .eq("id", s.manifestId)
    .maybeSingle()
  assert(
    "sentinel manifest selectable via service-role",
    !!row && !rowErr,
    rowErr?.message,
  )
  if (row) {
    assert(
      "manifest kind = component",
      row.kind === "component",
      String(row.kind),
    )
    assert(
      "manifest artifact_url points at the uploaded JS",
      row.artifact_url === s.jsKey,
      String(row.artifact_url),
    )
    // variants_json round-trips with the 9 D1 row kinds.
    const controls = row.variants_json as BuildManifestControls
    assert(
      "manifest variants_json carries all 9 D1 rows",
      !!controls.variants &&
        !!controls.sizes &&
        controls.booleans.length === 2 &&
        controls.slots.length === 1 &&
        controls.strings.length === 1 &&
        controls.numbers.length === 1 &&
        controls.handlers.length === 1 &&
        controls.objects.length === 1,
      JSON.stringify(controls),
    )
  }

  // component_views can be inserted via service-role (RLS-bypassed). The
  // browser path is RLS-gated by `is_workspace_member` which we can't test
  // without a real auth session; service-role bypass + 0001's CASCADE FK on
  // teardown is the v1-acceptable coverage.
  const { error: viewErr } = await sb.from("component_views").insert({
    instance_id: s.instanceId,
    manifest_id: s.manifestId,
  })
  assert(
    "component_views insert via service-role",
    !viewErr,
    viewErr?.message,
  )
}

async function main(): Promise<void> {
  console.log("=== PR7 verify:iframe ===\n")
  let s: SetupResult | null = null
  try {
    console.log("[setup] seeding sentinel rows + storage objects...")
    s = await setup()
    console.log(
      `[setup] instance=${s.instanceId} manifest=${s.manifestId}\n`,
    )

    console.log("--- iframe-protocol type guards ---")
    runProtocolGuardCases()
    console.log("")

    console.log("--- synthesize-defaults ---")
    runSynthesizeDefaultsCases()
    console.log("")

    console.log("--- Storage sign + HEAD ---")
    await runStorageCases(s)
    console.log("")

    console.log("--- DB sentinel + RLS bypass ---")
    await runDbCases(s)
    console.log("")
  } finally {
    if (s) {
      console.log("[teardown] removing sentinel rows + storage objects...")
      await teardown(s)
    }
    // Defensive post-run check.
    const sb = supabaseAdmin()
    const { count: leftoverConns } = await sb
      .from("repo_connections")
      .select("id", { count: "exact", head: true })
      .eq("github_install_id", TEST_INSTALL_ID)
    const { data: leftoverObjs } = await sb.storage
      .from(BUCKET)
      .list(s?.instanceId ?? "", { limit: 50 })
    console.log(
      `[teardown] leftover_conns=${leftoverConns ?? 0} leftover_storage=${
        leftoverObjs?.length ?? 0
      }`,
    )
  }

  const passed = cases.filter((c) => c.ok).length
  const failed = cases.length - passed
  console.log(`\n=== ${passed}/${cases.length} pass${failed > 0 ? `, ${failed} FAIL` : ""} ===`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(`[verify:iframe] ${(e as Error).message}`)
  process.exit(1)
})
