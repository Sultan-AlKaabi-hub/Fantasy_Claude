"""
GLOOMFALL — a dark fantasy roguelike.
Single-file Streamlit application with a self-contained HTML5 Canvas engine.

ARCHITECTURE
------------
Python (Streamlit) owns *meta-progression only*: banked Gloom Shards, purchased
upgrades, lifetime statistics, and player settings. It is the Sanctum.

JavaScript (a single embedded canvas component) owns *the run*: procedural
dungeon generation, turn resolution, field-of-view, lighting, particles,
rendering and audio. The entire real-time loop lives inside one iframe with
zero Python round-trips, which is what guarantees a stable 60 FPS.

DATA BRIDGE
-----------
Python -> JS   Direct JSON injection at render time (authoritative, lossless).
JS -> Python   A signed "Run Seal": a compact base64url payload with an FNV-1a
               checksum, emitted when a run ends. The canvas attempts to
               auto-fill the Sanctum's seal field in the parent document; if the
               host blocks cross-frame DOM access, the seal is copied to the
               clipboard and shown on the death screen for a one-tap paste.
               Every seal carries a single-use nonce, so the automatic and
               manual paths can never double-credit the same run.

               Note: the checksum guards against transcription errors and
               corruption, not against a determined player. The salt ships in
               client code, so this is tamper-evident, not tamper-proof. A
               server-authoritative variant would move seal minting behind an
               API; that is out of scope for a local/offline single-player build.

CRASH & REMOUNT SAFETY
----------------------
Buying an upgrade re-renders the Streamlit page, which remounts the iframe. The
canvas therefore serialises the full run to localStorage every turn and restores
on mount, so shopping mid-run (or an accidental refresh) never destroys a
descent. If localStorage is unavailable the game degrades gracefully to
session-only runs.

MOBILE / APK READINESS
----------------------
- Fixed 256x448 low-resolution backbuffer (9:16-ish portrait), nearest-neighbour
  upscaled. Fill rate is constant regardless of device resolution.
- All controls are touch-first and drawn inside the canvas (virtual D-pad plus
  two action keys); keyboard is an equal-parity alternative, never a requirement.
- No webfonts, no CDN assets, no network calls at runtime. Every sprite, tile and
  sound is synthesised procedurally at boot.
- The component HTML is a pure static document, so it can be lifted verbatim into
  a Capacitor / WebView shell. Only the Sanctum shop would need a native rewrite.

Run with:  streamlit run app.py
Requires:  streamlit >= 1.28
"""

from __future__ import annotations

import base64
import json
from typing import Any, Dict, List, Optional, Tuple

import streamlit as st
import streamlit.components.v1 as components

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

APP_NAME = "GLOOMFALL"
APP_VERSION = "1.0.0"
SAVE_SCHEMA = 3

# Shared secret for seal checksums. Present in client code by necessity; see the
# module docstring for the honest security posture.
SEAL_SALT = "gloomfall::seal::v1"
SEAL_PREFIX = "GLM1"

# Defensive caps so a malformed or hand-edited seal can never inject absurd values.
MAX_SEAL_SHARDS = 100_000
MAX_SEAL_DEPTH = 999
MAX_SEAL_KILLS = 99_999
MAX_CONSUMED_NONCES = 400

# Palette — deep purples, crimson, charcoal black, neon green.
PAL = {
    "void": "#05040a",
    "ink": "#0b0912",
    "charcoal": "#14111d",
    "stone": "#221d33",
    "stone_hi": "#332b4d",
    "purple": "#4a2c7a",
    "purple_hi": "#7a52c0",
    "crimson": "#a01130",
    "crimson_hi": "#e0455f",
    "neon": "#39ff88",
    "neon_dim": "#1a9c58",
    "bone": "#d9d2b8",
    "bone_dim": "#8f8768",
    "gold": "#e0b34a",
}

# ---------------------------------------------------------------------------
# Upgrade definitions — single source of truth, injected into the canvas.
# ---------------------------------------------------------------------------

UPGRADES: List[Dict[str, Any]] = [
    {
        "id": "grave_vigor",
        "name": "Grave Vigor",
        "sigil": "✚",
        "flavour": "Marrow grafted from the ossuary floor. It aches, and it holds.",
        "effect": "+14 max vitality each rank",
        "max": 5,
        "costs": [30, 80, 140, 230, 360],
        "params": {"maxHp": 14},
    },
    {
        "id": "cruel_edge",
        "name": "Cruel Edge",
        "sigil": "⚔",
        "flavour": "The blade remembers every throat it has opened.",
        "effect": "+2 attack each rank",
        "max": 5,
        "costs": [55, 95, 165, 270, 420],
        "params": {"dmg": 2},
    },
    {
        "id": "warding_sigil",
        "name": "Warding Sigil",
        "sigil": "◈",
        "flavour": "Burned beneath the skin. It turns aside the first bite.",
        "effect": "+1 armour each rank",
        "max": 4,
        "costs": [70, 130, 240, 400],
        "params": {"armor": 1},
    },
    {
        "id": "ember_sight",
        "name": "Ember Sight",
        "sigil": "◎",
        "flavour": "Cold fire behind the eyes. The dark gives up a little ground.",
        "effect": "+0.9 light radius each rank",
        "max": 4,
        "costs": [40, 110, 190, 310],
        "params": {"light": 0.9},
    },
    {
        "id": "blood_siphon",
        "name": "Blood Siphon",
        "sigil": "❦",
        "flavour": "Every wound you open feeds you a little of what spills.",
        "effect": "+8% lifesteal each rank",
        "max": 4,
        "costs": [90, 160, 280, 460],
        "params": {"lifesteal": 0.08},
    },
    {
        "id": "shadow_dash",
        "name": "Shadow Dash",
        "sigil": "➤",
        "flavour": "Step between two moments. Whatever stands in the gap is cut.",
        "effect": "Unlocks the dash, then shortens its cooldown",
        "max": 3,
        "costs": [120, 220, 380],
        "params": {"dashCd": [0, 8, 6, 4]},
    },
    {
        "id": "rusted_fortune",
        "name": "Rusted Fortune",
        "sigil": "◇",
        "flavour": "The Gloom yields more to those who have already paid it.",
        "effect": "+25% shards recovered each rank",
        "max": 4,
        "costs": [80, 150, 260, 430],
        "params": {"shardMul": 0.25},
    },
    {
        "id": "alchemists_kit",
        "name": "Alchemist's Kit",
        "sigil": "⚱",
        "flavour": "Begin the descent with more crimson in the satchel.",
        "effect": "+1 starting flask each rank",
        "max": 3,
        "costs": [75, 140, 250],
        "params": {"flasks": 1},
    },
    {
        "id": "hunters_instinct",
        "name": "Hunter's Instinct",
        "sigil": "⟁",
        "flavour": "You feel them breathing through the stone.",
        "effect": "Sense enemies 2 tiles further through walls each rank",
        "max": 3,
        "costs": [85, 150, 265],
        "params": {"sense": 2},
    },
    {
        "id": "second_breath",
        "name": "Second Breath",
        "sigil": "☘",
        "flavour": "Death loosens its grip. Once. It will not do so twice.",
        "effect": "Revive once per descent at 40% vitality, 60% at rank 2",
        "max": 2,
        "costs": [300, 650],
        "params": {"revive": [0, 0.40, 0.60]},
    },
]

UPGRADE_INDEX = {u["id"]: u for u in UPGRADES}


# ---------------------------------------------------------------------------
# Seal codec — must stay byte-identical to the JS implementation.
# ---------------------------------------------------------------------------


def fnv1a(text: str) -> int:
    """32-bit FNV-1a. Mirrored exactly in the canvas via Math.imul."""
    h = 0x811C9DC5
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def parse_seal(raw: str) -> Tuple[Optional[Dict[str, Any]], str]:
    """Validate and decode a Run Seal. Returns (payload, error_message)."""
    seal = (raw or "").strip().replace(" ", "").replace("\n", "")
    if not seal:
        return None, "Paste a seal first."

    parts = seal.split(".")
    if len(parts) != 3 or parts[0] != SEAL_PREFIX:
        return None, "That is not a Gloomfall seal. Expected three parts beginning with GLM1."

    _, body, checksum = parts
    try:
        expected = fnv1a(SEAL_SALT + body)
        if int(checksum, 16) != expected:
            return None, "Seal checksum failed. It was truncated or altered in transit."
    except ValueError:
        return None, "Seal checksum is not valid hexadecimal."

    try:
        padding = "=" * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(body + padding).decode("utf-8"))
    except Exception:
        return None, "Seal body could not be decoded."

    if not isinstance(payload, dict):
        return None, "Seal body is not a record."

    try:
        nonce = str(payload["n"])
        shards = int(payload["s"])
        depth = int(payload["d"])
        kills = int(payload["k"])
        turns = int(payload.get("t", 0))
    except (KeyError, TypeError, ValueError):
        return None, "Seal is missing required fields."

    if not nonce or len(nonce) > 32:
        return None, "Seal nonce is malformed."
    if not (0 <= shards <= MAX_SEAL_SHARDS):
        return None, "Seal reports an impossible shard count."
    if not (0 <= depth <= MAX_SEAL_DEPTH):
        return None, "Seal reports an impossible depth."
    if not (0 <= kills <= MAX_SEAL_KILLS):
        return None, "Seal reports an impossible kill count."

    return {
        "nonce": nonce,
        "shards": shards,
        "depth": depth,
        "kills": kills,
        "turns": max(0, turns),
    }, ""


def bank_seal(raw: str) -> Tuple[bool, str]:
    """Consume a seal exactly once and fold its results into meta-progression."""
    payload, error = parse_seal(raw)
    if payload is None:
        return False, error

    meta = st.session_state.meta
    if payload["nonce"] in meta["consumed"]:
        return False, "This seal has already been banked."

    meta["consumed"].append(payload["nonce"])
    if len(meta["consumed"]) > MAX_CONSUMED_NONCES:
        del meta["consumed"][:-MAX_CONSUMED_NONCES]

    meta["shards"] += payload["shards"]
    meta["kills"] += payload["kills"]
    meta["turns"] += payload["turns"]
    meta["runs"] += 1
    meta["best_depth"] = max(meta["best_depth"], payload["depth"])

    return True, (
        f"Banked {payload['shards']} shards from depth {payload['depth']} "
        f"({payload['kills']} slain)."
    )


# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------


def default_meta() -> Dict[str, Any]:
    return {
        "schema": SAVE_SCHEMA,
        "shards": 0,
        "upgrades": {u["id"]: 0 for u in UPGRADES},
        "best_depth": 0,
        "kills": 0,
        "turns": 0,
        "runs": 0,
        "consumed": [],
    }


def ensure_state() -> None:
    if "meta" not in st.session_state or st.session_state.meta.get("schema") != SAVE_SCHEMA:
        st.session_state.meta = default_meta()
    # Tolerate upgrade list changes across versions.
    for upgrade in UPGRADES:
        st.session_state.meta["upgrades"].setdefault(upgrade["id"], 0)

    st.session_state.setdefault("muted", False)
    st.session_state.setdefault("viewport_h", 780)
    st.session_state.setdefault("build_id", 0)
    st.session_state.setdefault("notice", None)
    st.session_state.setdefault("confirm_wipe", False)


def next_cost(upgrade: Dict[str, Any], level: int) -> Optional[int]:
    if level >= upgrade["max"]:
        return None
    return upgrade["costs"][level]


def buy(upgrade_id: str) -> None:
    meta = st.session_state.meta
    upgrade = UPGRADE_INDEX[upgrade_id]
    level = meta["upgrades"][upgrade_id]
    cost = next_cost(upgrade, level)
    if cost is None:
        st.session_state.notice = ("warn", f"{upgrade['name']} is already at its highest rank.")
        return
    if meta["shards"] < cost:
        st.session_state.notice = ("warn", f"{cost - meta['shards']} more shards needed.")
        return
    meta["shards"] -= cost
    meta["upgrades"][upgrade_id] = level + 1
    st.session_state.build_id += 1
    st.session_state.notice = ("good", f"{upgrade['name']} raised to rank {level + 1}.")


# ---------------------------------------------------------------------------
# Chrome
# ---------------------------------------------------------------------------

SHELL_CSS = """
<style>
  :root {
    --gf-void:#05040a; --gf-ink:#0b0912; --gf-stone:#221d33;
    --gf-purple:#4a2c7a; --gf-purple-hi:#7a52c0;
    --gf-crimson:#a01130; --gf-crimson-hi:#e0455f;
    --gf-neon:#39ff88; --gf-bone:#d9d2b8; --gf-bone-dim:#8f8768;
    --gf-gold:#e0b34a;
  }
  .stApp { background: radial-gradient(120% 90% at 50% 0%, #14111d 0%, #05040a 70%); }
  section[data-testid="stSidebar"] {
    background: linear-gradient(180deg, #0d0a16 0%, #07050d 100%);
    border-right: 1px solid #2b2340;
  }
  section[data-testid="stSidebar"] * { color: var(--gf-bone); }

  .gf-crest {
    font-family: "Iowan Old Style","Palatino Linotype","Book Antiqua",Georgia,serif;
    font-size: 1.5rem; letter-spacing: .18em; color: var(--gf-bone);
    margin: .1rem 0 0; line-height: 1.1;
  }
  .gf-crest span { color: var(--gf-crimson-hi); }
  .gf-sub {
    font-family: "Iowan Old Style",Georgia,serif; font-style: italic;
    color: var(--gf-bone-dim); font-size: .82rem; margin: .15rem 0 1rem;
  }
  .gf-purse {
    display:flex; align-items:baseline; gap:.5rem;
    border-top:1px solid #2b2340; border-bottom:1px solid #2b2340;
    padding:.55rem 0; margin-bottom:.9rem;
  }
  .gf-purse b {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 1.45rem; color: var(--gf-neon); font-weight: 600;
  }
  .gf-purse i { font-style:normal; color: var(--gf-bone-dim); font-size:.72rem; letter-spacing:.14em; }

  .gf-up { padding:.15rem 0 .1rem; }
  .gf-up-head { display:flex; align-items:baseline; gap:.45rem; }
  .gf-up-name {
    font-family:"Iowan Old Style",Georgia,serif; font-size:1rem; color:var(--gf-bone);
  }
  .gf-up-sigil { color:var(--gf-purple-hi); font-size:1rem; }
  .gf-up-rank {
    margin-left:auto; font-family:ui-monospace,Menlo,monospace;
    font-size:.72rem; color:var(--gf-gold);
  }
  .gf-up-eff { color:var(--gf-neon); font-size:.75rem; margin:.1rem 0 .05rem; }
  .gf-up-flav {
    color:var(--gf-bone-dim); font-size:.74rem; font-style:italic;
    font-family:"Iowan Old Style",Georgia,serif; margin:0 0 .35rem;
  }
  .gf-pips { letter-spacing:.22em; font-size:.7rem; color:var(--gf-purple-hi); }

  .gf-stat { display:flex; justify-content:space-between; font-size:.8rem; padding:.16rem 0; }
  .gf-stat span:last-child {
    font-family:ui-monospace,Menlo,monospace; color:var(--gf-bone);
  }
  .gf-stat span:first-child { color:var(--gf-bone-dim); }

  section[data-testid="stSidebar"] .stButton > button {
    width:100%; background:#170f24; color:var(--gf-bone);
    border:1px solid #3a2a58; border-radius:2px;
    font-family:ui-monospace,Menlo,monospace; font-size:.76rem; letter-spacing:.06em;
    padding:.3rem .5rem; transition:background .12s ease, border-color .12s ease;
  }
  section[data-testid="stSidebar"] .stButton > button:hover:not(:disabled) {
    background:var(--gf-purple); border-color:var(--gf-purple-hi); color:#fff;
  }
  section[data-testid="stSidebar"] .stButton > button:focus-visible {
    outline:2px solid var(--gf-neon); outline-offset:2px;
  }
  section[data-testid="stSidebar"] .stButton > button:disabled {
    background:#0e0b16; border-color:#241c36; color:#4c4560;
  }
  section[data-testid="stSidebar"] hr { border-color:#241c36; margin:.7rem 0; }

  .gf-note { font-size:.78rem; padding:.4rem .6rem; border-left:2px solid; margin:.3rem 0 .6rem; }
  .gf-note.good { border-color:var(--gf-neon); color:var(--gf-neon); background:#0b1a12; }
  .gf-note.warn { border-color:var(--gf-crimson-hi); color:var(--gf-crimson-hi); background:#1a0b10; }

  .block-container { padding-top:1.1rem; padding-bottom:.6rem; max-width:1100px; }
  #MainMenu, footer { visibility:hidden; }
  @media (max-width: 640px) { .block-container { padding-left:.4rem; padding-right:.4rem; } }
</style>
"""


def render_sidebar() -> None:
    meta = st.session_state.meta
    sb = st.sidebar

    sb.markdown(
        '<div class="gf-crest">THE <span>SANCTUM</span></div>'
        '<div class="gf-sub">What you carry out of the dark, you keep forever.</div>',
        unsafe_allow_html=True,
    )
    sb.markdown(
        f'<div class="gf-purse"><b>{meta["shards"]:,}</b><i>GLOOM SHARDS BANKED</i></div>',
        unsafe_allow_html=True,
    )

    if st.session_state.notice:
        kind, text = st.session_state.notice
        sb.markdown(f'<div class="gf-note {kind}">{text}</div>', unsafe_allow_html=True)
        st.session_state.notice = None

    # -- Seal banking -------------------------------------------------------
    sb.markdown("**Bank a run**")
    sb.caption(
        "A seal is minted when you fall or retreat. It usually fills itself in — "
        "if it does not, paste it here."
    )
    seal_text = sb.text_input(
        "Run Seal",
        key="seal_input",
        placeholder="GLM1.…",
        label_visibility="collapsed",
    )
    if sb.button("Bank this seal", key="bank_btn", use_container_width=True):
        ok, message = bank_seal(seal_text)
        st.session_state.notice = ("good" if ok else "warn", message)
        if ok:
            st.session_state.build_id += 1
        st.rerun()

    sb.markdown("---")

    # -- Shop ---------------------------------------------------------------
    sb.markdown("**Permanent rites**")
    for upgrade in UPGRADES:
        level = meta["upgrades"][upgrade["id"]]
        cost = next_cost(upgrade, level)
        pips = "◆" * level + "◇" * (upgrade["max"] - level)

        sb.markdown(
            f'<div class="gf-up">'
            f'<div class="gf-up-head">'
            f'<span class="gf-up-sigil">{upgrade["sigil"]}</span>'
            f'<span class="gf-up-name">{upgrade["name"]}</span>'
            f'<span class="gf-up-rank">{level}/{upgrade["max"]}</span>'
            f"</div>"
            f'<div class="gf-pips">{pips}</div>'
            f'<div class="gf-up-eff">{upgrade["effect"]}</div>'
            f'<div class="gf-up-flav">{upgrade["flavour"]}</div>'
            f"</div>",
            unsafe_allow_html=True,
        )

        if cost is None:
            sb.button("Mastered", key=f"buy_{upgrade['id']}", disabled=True, use_container_width=True)
        else:
            affordable = meta["shards"] >= cost
            sb.button(
                f"Raise rank — {cost} shards",
                key=f"buy_{upgrade['id']}",
                disabled=not affordable,
                use_container_width=True,
                on_click=buy,
                args=(upgrade["id"],),
            )
        sb.markdown('<div style="height:.45rem"></div>', unsafe_allow_html=True)

    sb.markdown("---")

    # -- Chronicle ----------------------------------------------------------
    sb.markdown("**Chronicle**")
    rows = [
        ("Deepest descent", f"{meta['best_depth']}"),
        ("Descents made", f"{meta['runs']}"),
        ("Slain", f"{meta['kills']:,}"),
        ("Turns endured", f"{meta['turns']:,}"),
    ]
    sb.markdown(
        "".join(f'<div class="gf-stat"><span>{k}</span><span>{v}</span></div>' for k, v in rows),
        unsafe_allow_html=True,
    )

    sb.markdown("---")

    # -- Settings -----------------------------------------------------------
    sb.markdown("**Settings**")
    muted = sb.toggle("Silence the dark", value=st.session_state.muted, key="mute_toggle")
    if muted != st.session_state.muted:
        st.session_state.muted = muted
        st.session_state.build_id += 1
        st.rerun()

    height = sb.slider("Viewport height", 520, 1100, st.session_state.viewport_h, 20)
    if height != st.session_state.viewport_h:
        st.session_state.viewport_h = height
        st.rerun()

    if st.session_state.confirm_wipe:
        sb.markdown(
            '<div class="gf-note warn">This erases every rite and every shard.</div>',
            unsafe_allow_html=True,
        )
        col_a, col_b = sb.columns(2)
        if col_a.button("Erase it all", key="wipe_yes", use_container_width=True):
            st.session_state.meta = default_meta()
            st.session_state.confirm_wipe = False
            st.session_state.build_id += 1
            st.session_state.notice = ("warn", "The Sanctum is empty again.")
            st.rerun()
        if col_b.button("Keep it", key="wipe_no", use_container_width=True):
            st.session_state.confirm_wipe = False
            st.rerun()
    else:
        if sb.button("Erase all progress", key="wipe_ask", use_container_width=True):
            st.session_state.confirm_wipe = True
            st.rerun()

    sb.caption(f"{APP_NAME} v{APP_VERSION}")


# ---------------------------------------------------------------------------
# Canvas component
# ---------------------------------------------------------------------------


def build_config() -> Dict[str, Any]:
    meta = st.session_state.meta
    return {
        "version": APP_VERSION,
        "buildId": st.session_state.build_id,
        "muted": bool(st.session_state.muted),
        "sealSalt": SEAL_SALT,
        "sealPrefix": SEAL_PREFIX,
        "upgrades": meta["upgrades"],
        "upgradeDefs": [
            {"id": u["id"], "name": u["name"], "max": u["max"], "params": u["params"]}
            for u in UPGRADES
        ],
        "meta": {
            "bestDepth": meta["best_depth"],
            "runs": meta["runs"],
            "shards": meta["shards"],
        },
        "palette": PAL,
        "storageKey": f"gloomfall::run::v{SAVE_SCHEMA}",
    }


GAME_HTML = r"""
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
  html,body{margin:0;padding:0;height:100%;background:#05040a;overflow:hidden;
    -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;}
  #stage{position:relative;width:100%;height:100vh;display:flex;align-items:center;
    justify-content:center;background:radial-gradient(120% 80% at 50% 0%,#100d1a,#05040a 75%);
    touch-action:none;outline:none;}
  #frame{position:relative;line-height:0;box-shadow:0 0 0 1px #2b2340,0 18px 60px rgba(0,0,0,.85);}
  canvas{display:block;position:absolute;left:0;top:0;}
  #scene{position:relative;image-rendering:pixelated;image-rendering:crisp-edges;}
  #text{pointer-events:none;}
  @media (prefers-reduced-motion: reduce){ #frame{box-shadow:0 0 0 1px #2b2340;} }
</style>

<div id="stage" tabindex="0" aria-label="Gloomfall game viewport">
  <div id="frame">
    <canvas id="scene" width="256" height="448"></canvas>
    <canvas id="text"></canvas>
  </div>
</div>

<script>
(function(){
'use strict';

/* =====================================================================
   0. CONFIGURATION FROM PYTHON
   ===================================================================== */
const CFG = __GLOOMFALL_CONFIG__;
const PAL = CFG.palette;

/* =====================================================================
   1. CONSTANTS & UTILITIES
   ===================================================================== */
const BASE_W = 256, BASE_H = 448;      // low-res backbuffer, ~9:16 portrait
const TILE   = 16;
const MAP_W  = 36, MAP_H = 36;
const LW = BASE_W >> 1, LH = BASE_H >> 1;   // lightmap runs at half res

const T = { WALL:0, FLOOR:1, POOL:2, STAIRS:3, RUBBLE:4, BONES:5 };
const SOLID = { 0:true, 1:false, 2:false, 3:false, 4:false, 5:false };

const MOVE_SMOOTH = 19;      // exponential smoothing factor for entity motion
const INPUT_REPEAT = 105;    // ms between repeats while a direction is held

const clamp = (v,a,b) => v < a ? a : (v > b ? b : v);
const lerp  = (a,b,t) => a + (b-a) * t;
const sign  = (v) => v < 0 ? -1 : (v > 0 ? 1 : 0);
const idx   = (x,y) => y * MAP_W + x;
const inMap = (x,y) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;

function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fnv1a(str){
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(str);
  for (let i = 0; i < bytes.length; i++){
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const ROMAN = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],
               [50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
function roman(n){
  if (n <= 0) return '0';
  if (n > 3999) return String(n);
  let out = '';
  for (const [v,s] of ROMAN){ while (n >= v){ out += s; n -= v; } }
  return out;
}

/* =====================================================================
   2. DERIVED PLAYER STATS FROM META-PROGRESSION
   ===================================================================== */
function rank(id){ return (CFG.upgrades && CFG.upgrades[id]) | 0; }
function paramOf(id){
  const defs = CFG.upgradeDefs || [];
  const def = defs.find(d => d.id === id);
  return (def && def.params) ? def.params : {};
}
/* A missing definition must degrade to "no bonus", never to NaN. A single
   undefined multiplicand would otherwise poison every stat downstream and
   silently disable death checks, so this boundary is guarded explicitly. */
function bonus(id, key){
  const v = paramOf(id)[key];
  return (typeof v === 'number' && isFinite(v)) ? rank(id) * v : 0;
}
function tableAt(id, key){
  const t = paramOf(id)[key];
  if (!Array.isArray(t) || !t.length) return 0;
  const v = t[clamp(rank(id), 0, t.length - 1)];
  return (typeof v === 'number' && isFinite(v)) ? v : 0;
}
function derivedStats(){
  const s = {
    maxHp:    60  + bonus('grave_vigor',     'maxHp'),
    dmg:       7  + bonus('cruel_edge',      'dmg'),
    armor:     0  + bonus('warding_sigil',   'armor'),
    light:     6.2+ bonus('ember_sight',     'light'),
    lifesteal:      bonus('blood_siphon',    'lifesteal'),
    shardMul:  1  + bonus('rusted_fortune',  'shardMul'),
    flasks:    1  + bonus('alchemists_kit',  'flasks'),
    sense:          bonus('hunters_instinct','sense'),
    crit: 0.10
  };
  s.dashCdMax = tableAt('shadow_dash', 'dashCd');
  s.hasDash   = rank('shadow_dash') > 0 && s.dashCdMax > 0;
  s.revivePct = tableAt('second_breath', 'revive');
  s.revives   = s.revivePct > 0 ? 1 : 0;
  return s;
}

/* =====================================================================
   3. PROCEDURAL PIXEL-ART ATLAS
   Every sprite is drawn once into an offscreen canvas at native 16px and
   then blitted with smoothing disabled. This keeps per-frame work to pure
   drawImage calls, which is what holds the frame budget on mobile GPUs.
   ===================================================================== */
function mkc(w,h){
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  return { c: c, x: x };
}
function px(g,x,y,col,w,h){ g.fillStyle = col; g.fillRect(x, y, w||1, h||1); }

const ATLAS = { floor: [], wall: [], pool: [], rubble: [], bones: [], ent: {} };

function buildFloor(rng, variant){
  const t = mkc(TILE,TILE), g = t.x;
  px(g,0,0,'#14111d',TILE,TILE);
  for (let i = 0; i < 46; i++){
    const x = (rng()*TILE)|0, y = (rng()*TILE)|0;
    px(g,x,y, rng() < .5 ? '#191524' : '#100d18');
  }
  // Flagstone seams give the floor a readable grid without a hard outline.
  if (variant % 2 === 0){ px(g,0,0,'#0c0a13',TILE,1); px(g,0,0,'#0c0a13',1,TILE); }
  if (variant === 1){
    const cy = 4 + ((rng()*8)|0);
    for (let x = 2; x < 14; x++){ px(g,x,cy + (((rng()*3)|0)-1),'#0b0912'); }
  }
  if (variant === 3){
    px(g,5,10,'#3a3350',3,1); px(g,6,9,'#3a3350',1,1);   // a bone fleck
  }
  if (rng() < .30){
    const x = 2 + ((rng()*12)|0), y = 2 + ((rng()*12)|0);
    px(g,x,y,'#2a1030'); px(g,x+1,y,'#200c26');
  }
  return t.c;
}

function buildWall(rng, variant){
  const t = mkc(TILE,TILE), g = t.x;
  px(g,0,0,'#221d33',TILE,TILE);
  // Block courses.
  px(g,0,0,'#332b4d',TILE,3);        // lit cap
  px(g,0,3,'#191428',TILE,1);        // shadow under cap
  px(g,0,8,'#191428',TILE,1);
  px(g,7,4,'#191428',1,4);
  px(g,3,9,'#191428',1,7);
  px(g,11,9,'#191428',1,7);
  px(g,0,TILE-2,'#0f0c18',TILE,2);   // base shadow
  for (let i = 0; i < 30; i++){
    const x = (rng()*TILE)|0, y = 3 + ((rng()*13)|0);
    px(g,x,y, rng() < .5 ? '#282142' : '#1c1729');
  }
  if (variant === 1){                 // crimson rune
    px(g,6,6,'#7a0f26',4,1); px(g,7,5,'#7a0f26',1,3); px(g,7,6,'#c8203f');
  }
  if (variant === 2){                 // creeping moss, echoing the neon pools
    px(g,1,3,'#1a5c39',3,1); px(g,2,4,'#227a4a',2,1); px(g,12,3,'#1a5c39',3,1);
  }
  if (variant === 3){                 // fracture
    px(g,9,4,'#0f0c18',1,5); px(g,10,8,'#0f0c18',1,4); px(g,8,11,'#0f0c18',1,3);
  }
  return t.c;
}

function buildPool(rng, frame){
  const t = mkc(TILE,TILE), g = t.x;
  px(g,0,0,'#0c0f14',TILE,TILE);
  px(g,1,2,'#0b2b1c',14,12);
  px(g,2,3,'#12603a',12,10);
  px(g,3,4,'#1a9c58',10,8);
  const o = frame % 3;
  px(g,5,6 + (o === 2 ? 1 : 0),'#39ff88',6,4);
  px(g,6 + o,7,'#8dffc0',3,1);
  px(g,4 + ((frame*3) % 6),10,'#39ff88',2,1);
  for (let i = 0; i < 5; i++){
    px(g, 2 + ((rng()*12)|0), 3 + ((rng()*10)|0), '#8dffc0');
  }
  return t.c;
}

function buildStairs(){
  const t = mkc(TILE,TILE), g = t.x;
  px(g,0,0,'#14111d',TILE,TILE);
  px(g,1,1,'#05040a',14,14);
  px(g,2,2,'#332b4d',12,3);
  px(g,3,5,'#2a2440',10,3);
  px(g,4,8,'#221d33',8,3);
  px(g,5,11,'#1a1528',6,3);
  px(g,2,2,'#7a52c0',12,1);
  px(g,3,5,'#5c3f95',10,1);
  px(g,4,8,'#4a2c7a',8,1);
  px(g,6,13,'#39ff88',4,1);
  return t.c;
}

function buildRubble(rng, variant){
  const t = mkc(TILE,TILE), g = t.x;
  if (variant === 0){                       // broken pillar
    px(g,5,4,'#332b4d',6,11); px(g,5,4,'#443a63',6,2); px(g,6,7,'#221d33',1,7);
    px(g,4,14,'#1a1528',8,2);
  } else if (variant === 1){                 // rubble heap
    px(g,4,10,'#2a2440',8,4); px(g,6,8,'#332b4d',4,3);
    px(g,5,9,'#443a63',2,1); px(g,10,11,'#443a63',2,1);
  } else {                                   // iron brazier, dead
    px(g,7,9,'#2a2440',2,6); px(g,5,7,'#3a3350',6,2); px(g,6,6,'#221d33',4,1);
    px(g,5,15,'#1a1528',6,1);
  }
  for (let i = 0; i < 6; i++) px(g,(rng()*TILE)|0,(rng()*TILE)|0,'#191524');
  return t.c;
}

function buildBones(rng){
  const t = mkc(TILE,TILE), g = t.x;
  px(g,3,11,'#8f8768',9,1); px(g,4,12,'#d9d2b8',7,1);
  px(g,5,7,'#d9d2b8',4,4); px(g,6,9,'#0b0912',1,1); px(g,8,9,'#0b0912',1,1);
  px(g,10,6,'#8f8768',1,5); px(g,11,10,'#8f8768',2,1);
  for (let i = 0; i < 4; i++) px(g,(rng()*TILE)|0,(rng()*TILE)|0,'#a89c78');
  return t.c;
}

/* --- Entities ------------------------------------------------------- */
function buildPlayer(frame){
  const t = mkc(TILE,TILE), g = t.x;
  const bob = frame === 1 ? 1 : 0;
  const lunge = frame === 2 ? 1 : 0;
  px(g,4,15,'#05040a',8,1);                              // contact shadow
  px(g,4,7+bob,'#2b1b47',8,7);                           // cloak
  px(g,3,9+bob,'#241640',1,4); px(g,12,9+bob,'#241640',1,4);
  px(g,4,13+bob,'#1b1030',8,1);
  px(g,5,14+bob,'#161226',2,1); px(g,9,14+bob,'#161226',2,1);   // boots
  px(g,4,6+bob,'#a01130',8,1); px(g,5,7+bob,'#c8203f',3,1);     // crimson scarf
  px(g,5,2+bob,'#3a2456',6,5);                                   // hood
  px(g,4,3+bob,'#3a2456',1,4); px(g,11,3+bob,'#3a2456',1,4);
  px(g,5,2+bob,'#4f3272',6,1);
  px(g,6,4+bob,'#120e1c',4,3);                                   // shadowed face
  px(g,6,5+bob,'#8dffc0'); px(g,9,5+bob,'#8dffc0');              // eyes
  // Blade — swings forward on the attack frame.
  const bx = 12 + lunge*1;
  px(g,bx,4+bob-lunge,'#d9d2b8',1,7);
  px(g,bx,3+bob-lunge,'#f2ecd8',1,1);
  px(g,bx-1,10+bob,'#8f8768',3,1);
  if (lunge) px(g,bx+1,5+bob-1,'#e0455f',1,4);                   // arc of blood
  return t.c;
}

function buildCultist(frame){
  const t = mkc(TILE,TILE), g = t.x;
  const b = frame === 1 ? 1 : 0;
  px(g,4,15,'#05040a',8,1);
  px(g,4,6+b,'#2b1b47',8,9);                       // robe
  px(g,3,8+b,'#241640',1,5); px(g,12,8+b,'#241640',1,5);
  px(g,4,6+b,'#e0b34a',8,1);                       // gold trim
  px(g,5,14+b,'#e0b34a',6,1);
  px(g,6,1+b,'#3a2456',4,2);                       // pointed hood
  px(g,5,3+b,'#3a2456',6,4);
  px(g,6,4+b,'#0b0912',4,3);
  px(g,6,5+b,'#39ff88'); px(g,9,5+b,'#39ff88');    // green eyes
  px(g,12,9+b,'#8f8768',1,3);                      // candle
  px(g,12,8+b,'#39ff88'); px(g,12,7+b,'#8dffc0');
  return t.c;
}

function buildHusk(frame){
  const t = mkc(TILE,TILE), g = t.x;
  const s = frame === 1 ? 1 : 0;
  px(g,4,15,'#05040a',8,1);
  px(g,5,7,'#8f8768',6,5);                         // hunched torso
  px(g,5,7,'#a89c78',6,1);
  px(g,6,8,'#6e6650',1,3); px(g,9,8,'#6e6650',1,3);
  px(g,6,4,'#d9d2b8',4,4);                         // skull
  px(g,6,7,'#8f8768',4,1);
  px(g,6,5,'#e0455f'); px(g,9,5,'#e0455f');        // red eyes
  px(g,7,6,'#0b0912',2,1);
  // Spindly legs, alternating on the animation frame.
  px(g,3,11+s,'#a89c78',2,1); px(g,3,12+s,'#8f8768',1,3);
  px(g,11,11-s,'#a89c78',2,1); px(g,12,12-s,'#8f8768',1,3);
  px(g,5,12,'#8f8768',1,3); px(g,10,12,'#8f8768',1,3);
  return t.c;
}

function buildWraith(frame){
  const t = mkc(TILE,TILE), g = t.x;
  const b = frame === 1 ? 1 : 0;
  g.globalAlpha = 0.86;
  px(g,4,3+b,'#100c1a',8,9);                       // shrouded core
  px(g,3,5+b,'#100c1a',1,6); px(g,12,5+b,'#100c1a',1,6);
  px(g,5,2+b,'#171125',6,2);
  g.globalAlpha = 0.55;
  px(g,4,12+b,'#100c1a',2,2); px(g,7,12+b,'#100c1a',2,3);   // tattered hem
  px(g,10,12+b,'#100c1a',2,2);
  g.globalAlpha = 0.30;
  px(g,2,7+b,'#4a2c7a',1,4); px(g,13,7+b,'#4a2c7a',1,4);    // smoke
  g.globalAlpha = 1;
  px(g,6,6+b,'#8dffc0',2,1); px(g,9,6+b,'#8dffc0',2,1);     // eyes
  px(g,6,7+b,'#39ff88',1,1); px(g,10,7+b,'#39ff88',1,1);
  return t.c;
}

/* The Crowned Ossuary — 32x32, drawn from the crowned-skull reference. */
function buildOssuary(frame){
  const t = mkc(32,32), g = t.x;
  const b = frame === 1 ? 1 : 0;
  px(g,8,30,'#05040a',16,2);
  // Ribcage and shoulders
  px(g,9,18+b,'#8f8768',14,8);
  px(g,10,19+b,'#a89c78',12,1);
  for (let r = 0; r < 4; r++) px(g,10,20+b+r*2,'#6e6650',12,1);
  px(g,15,19+b,'#d9d2b8',2,7);
  // Arms
  px(g,4,20+b,'#a89c78',5,2); px(g,3,22+b,'#8f8768',2,5);
  px(g,23,20+b,'#a89c78',5,2); px(g,27,22+b,'#8f8768',2,5);
  px(g,2,27+b,'#d9d2b8',4,1); px(g,26,27+b,'#d9d2b8',4,1);
  // Gold chain across the collar
  px(g,8,17+b,'#e0b34a',16,1); px(g,10,18+b,'#f2cf7a',3,1); px(g,19,18+b,'#f2cf7a',3,1);
  // Skull
  px(g,10,5+b,'#d9d2b8',12,11);
  px(g,11,4+b,'#d9d2b8',10,1);
  px(g,9,7+b,'#c9c2a6',1,6); px(g,22,7+b,'#c9c2a6',1,6);
  px(g,11,16+b,'#a89c78',10,2);
  px(g,12,8+b,'#0b0912',3,4); px(g,17,8+b,'#0b0912',3,4);      // sockets
  px(g,13,9+b,'#e0455f',1,2); px(g,18,9+b,'#e0455f',1,2);      // ember gaze
  px(g,15,12+b,'#0b0912',2,2);
  px(g,12,16+b,'#0b0912',1,2); px(g,15,16+b,'#0b0912',1,2); px(g,18,16+b,'#0b0912',1,2);
  // Crown
  px(g,9,2+b,'#e0b34a',14,3);
  px(g,10,0+b,'#e0b34a',2,2); px(g,15,0+b,'#e0b34a',2,2); px(g,20,0+b,'#e0b34a',2,2);
  px(g,10,0+b,'#f7e2a8',1,1); px(g,15,0+b,'#f7e2a8',1,1); px(g,20,0+b,'#f7e2a8',1,1);
  px(g,9,2+b,'#f7e2a8',14,1);
  px(g,15,3+b,'#39ff88',2,1);                                    // bound soul-gem
  px(g,12,3+b,'#a07a1e',1,1); px(g,19,3+b,'#a07a1e',1,1);
  return t.c;
}

function buildShard(frame){
  const t = mkc(TILE,TILE), g = t.x;
  const b = frame === 1 ? 1 : 0;
  px(g,7,5+b,'#1a9c58',2,1);
  px(g,6,6+b,'#39ff88',4,3);
  px(g,5,7+b,'#39ff88',6,1);
  px(g,7,9+b,'#8dffc0',2,1);
  px(g,7,4+b,'#8dffc0',1,1);
  px(g,6,10+b,'#12603a',4,1);
  return t.c;
}

function buildFlask(frame){
  const t = mkc(TILE,TILE), g = t.x;
  const b = frame === 1 ? 1 : 0;
  px(g,6,4+b,'#8f8768',4,2);
  px(g,5,6+b,'#c9c2a6',6,7);
  px(g,6,8+b,'#a01130',4,4);
  px(g,6,8+b,'#e0455f',2,1);
  px(g,5,13+b,'#8f8768',6,1);
  return t.c;
}

function buildAtlas(){
  const rng = mulberry32(0x51DE5EED);
  for (let i = 0; i < 4; i++) ATLAS.floor.push(buildFloor(rng, i));
  for (let i = 0; i < 4; i++) ATLAS.wall.push(buildWall(rng, i));
  for (let i = 0; i < 3; i++) ATLAS.pool.push(buildPool(rng, i));
  for (let i = 0; i < 3; i++) ATLAS.rubble.push(buildRubble(rng, i));
  ATLAS.bones.push(buildBones(rng));
  ATLAS.stairs = buildStairs();
  ATLAS.ent.player  = [buildPlayer(0),  buildPlayer(1),  buildPlayer(2)];
  ATLAS.ent.cultist = [buildCultist(0), buildCultist(1)];
  ATLAS.ent.husk    = [buildHusk(0),    buildHusk(1)];
  ATLAS.ent.wraith  = [buildWraith(0),  buildWraith(1)];
  ATLAS.ent.boss    = [buildOssuary(0), buildOssuary(1)];
  ATLAS.shard = [buildShard(0), buildShard(1)];
  ATLAS.flask = [buildFlask(0), buildFlask(1)];
}

/* =====================================================================
   4. AUDIO — everything synthesised, nothing downloaded.
   Playback is deferred until the first gesture because browsers suspend
   AudioContexts created outside a user activation (MDN: Autoplay guide).
   ===================================================================== */
const Audio = {
  ctx:null, master:null, droneGain:null, nodes:[], started:false,
  muted: !!CFG.muted, lfo:null, filter:null,

  init(){
    if (this.started) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      this.master.connect(this.ctx.destination);
      this.buildDrone();
      this.started = true;
    } catch(e){ this.started = false; }
  },

  buildDrone(){
    const c = this.ctx;
    this.droneGain = c.createGain();
    this.droneGain.gain.value = 0.0;
    this.filter = c.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 220;
    this.filter.Q.value = 6;
    this.filter.connect(this.droneGain);
    this.droneGain.connect(this.master);

    // Two detuned saws a fifth apart plus a sub sine: a slow, unresolved drone.
    const freqs = [55, 82.4, 27.5];
    const types = ['sawtooth','sawtooth','sine'];
    const gains = [0.16, 0.11, 0.30];
    for (let i = 0; i < freqs.length; i++){
      const o = c.createOscillator();
      o.type = types[i];
      o.frequency.value = freqs[i];
      o.detune.value = (i - 1) * 7;
      const g = c.createGain();
      g.gain.value = gains[i];
      o.connect(g); g.connect(this.filter);
      o.start();
      this.nodes.push(o, g);
    }
    // A slow filter sweep keeps the loop from ever sitting still.
    this.lfo = c.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0.045;
    const lg = c.createGain();
    lg.gain.value = 110;
    this.lfo.connect(lg); lg.connect(this.filter.frequency);
    this.lfo.start();
    this.nodes.push(this.lfo, lg);

    this.droneGain.gain.setTargetAtTime(0.30, c.currentTime, 4.0);
  },

  resume(){
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(()=>{});
  },
  setMuted(m){
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
  },
  // Depth changes the tonal centre: deeper is lower and murkier.
  setDepth(d){
    if (!this.filter || !this.ctx) return;
    const f = clamp(260 - d * 12, 90, 260);
    this.filter.frequency.setTargetAtTime(f, this.ctx.currentTime, 2.0);
  },

  noiseBuffer(dur){
    const c = this.ctx, n = Math.max(1, (c.sampleRate * dur) | 0);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  },

  // Crunchy pixel noise: a bandpassed burst with a very fast decay.
  crunch(freq, dur, vol, type){
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuffer(dur);
    const bp = c.createBiquadFilter();
    bp.type = type || 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 1.4;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  },

  tone(freq, dur, vol, type, slideTo){
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },

  sfx(name){
    if (!this.started || this.muted) return;
    switch(name){
      case 'attack': this.crunch(1400, 0.09, 0.42); this.tone(160, 0.07, 0.10, 'square', 70); break;
      case 'hurt':   this.crunch(320, 0.20, 0.50, 'lowpass'); this.tone(90, 0.22, 0.16, 'sawtooth', 45); break;
      case 'kill':   this.crunch(700, 0.24, 0.40); this.tone(220, 0.30, 0.14, 'triangle', 60); break;
      case 'shard':  this.tone(880, 0.07, 0.16, 'square'); setTimeout(()=>this.tone(1320,0.09,0.13,'square'), 55); break;
      case 'flask':  this.tone(330, 0.10, 0.16, 'triangle', 660); break;
      case 'dash':   this.crunch(2600, 0.13, 0.28, 'highpass'); break;
      case 'stairs': [262,330,392,523].forEach((f,i)=>setTimeout(()=>this.tone(f,0.16,0.14,'triangle'), i*95)); break;
      case 'bump':   this.crunch(180, 0.05, 0.16, 'lowpass'); break;
      case 'boss':   this.tone(58,1.5,0.30,'sawtooth',41); this.crunch(200,1.1,0.26,'lowpass'); break;
      case 'death':  [330,262,196,147,98].forEach((f,i)=>setTimeout(()=>this.tone(f,0.42,0.20,'sawtooth'), i*160)); break;
      case 'revive': [196,262,392,523,784].forEach((f,i)=>setTimeout(()=>this.tone(f,0.24,0.16,'triangle'), i*80)); break;
    }
  }
};

/* =====================================================================
   5. DUNGEON GENERATION
   Rooms placed by rejection sampling, joined by 1-tile L corridors, then
   a few extra edges added so the graph has loops. Loops matter: a pure
   tree forces backtracking, which reads as tedium rather than tension.
   ===================================================================== */
function genMap(depth, seed){
  const rng = mulberry32(seed);
  const grid = new Uint8Array(MAP_W * MAP_H).fill(T.WALL);
  const rooms = [];
  const isBoss = depth % 5 === 0;

  function carveRoom(r){
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++)
        grid[idx(x,y)] = T.FLOOR;
  }
  function carveH(x1,x2,y){
    for (let x = Math.min(x1,x2); x <= Math.max(x1,x2); x++)
      if (inMap(x,y)) grid[idx(x,y)] = T.FLOOR;
  }
  function carveV(y1,y2,x){
    for (let y = Math.min(y1,y2); y <= Math.max(y1,y2); y++)
      if (inMap(x,y)) grid[idx(x,y)] = T.FLOOR;
  }
  function overlaps(a){
    for (const b of rooms){
      if (a.x - 2 < b.x + b.w && a.x + a.w + 2 > b.x &&
          a.y - 2 < b.y + b.h && a.y + a.h + 2 > b.y) return true;
    }
    return false;
  }

  if (isBoss){
    const bw = 15, bh = 13;
    const br = { x:(MAP_W-bw)>>1, y:6, w:bw, h:bh };
    br.cx = br.x + (bw>>1); br.cy = br.y + (bh>>1);
    rooms.push(br); carveRoom(br);
    const entry = { x:(MAP_W-7)>>1, y:MAP_H-12, w:7, h:6 };
    entry.cx = entry.x + 3; entry.cy = entry.y + 3;
    rooms.push(entry); carveRoom(entry);
    carveV(br.cy, entry.cy, br.cx);
    for (let i = 0; i < 3; i++){
      const w = 4 + ((rng()*3)|0), h = 4 + ((rng()*3)|0);
      const r = { x: 2 + ((rng()*(MAP_W-w-4))|0), y: 2 + ((rng()*(MAP_H-h-4))|0), w:w, h:h };
      r.cx = r.x + (w>>1); r.cy = r.y + (h>>1);
      if (overlaps(r)) continue;
      rooms.push(r); carveRoom(r);
      carveH(r.cx, entry.cx, r.cy); carveV(r.cy, entry.cy, entry.cx);
    }
  } else {
    const target = 9 + Math.min(depth, 7);
    for (let attempt = 0; attempt < 260 && rooms.length < target; attempt++){
      const w = 4 + ((rng()*5)|0);
      const h = 4 + ((rng()*4)|0);
      const r = { x: 2 + ((rng()*(MAP_W-w-4))|0), y: 2 + ((rng()*(MAP_H-h-4))|0), w:w, h:h };
      r.cx = r.x + (w>>1); r.cy = r.y + (h>>1);
      if (overlaps(r)) continue;
      rooms.push(r); carveRoom(r);
    }
    for (let i = 1; i < rooms.length; i++){
      const a = rooms[i-1], b = rooms[i];
      if (rng() < 0.5){ carveH(a.cx,b.cx,a.cy); carveV(a.cy,b.cy,b.cx); }
      else            { carveV(a.cy,b.cy,a.cx); carveH(a.cx,b.cx,b.cy); }
    }
    const extra = 1 + ((rng()*3)|0);
    for (let i = 0; i < extra && rooms.length > 3; i++){
      const a = rooms[(rng()*rooms.length)|0], b = rooms[(rng()*rooms.length)|0];
      if (a === b) continue;
      carveH(a.cx,b.cx,a.cy); carveV(a.cy,b.cy,b.cx);
    }
  }

  // Seal the border so nothing can path off the map.
  for (let x = 0; x < MAP_W; x++){ grid[idx(x,0)] = T.WALL; grid[idx(x,MAP_H-1)] = T.WALL; }
  for (let y = 0; y < MAP_H; y++){ grid[idx(0,y)] = T.WALL; grid[idx(MAP_W-1,y)] = T.WALL; }

  const start = rooms[isBoss ? 1 : 0];
  const startPos = { x: start.cx, y: start.cy };

  // Stairs go in whichever room centre is furthest from the entrance.
  let far = rooms[0], best = -1;
  for (const r of rooms){
    const d = Math.abs(r.cx - startPos.x) + Math.abs(r.cy - startPos.y);
    if (d > best){ best = d; far = r; }
  }
  const stairs = { x: far.cx, y: far.cy };
  if (!isBoss) grid[idx(stairs.x, stairs.y)] = T.STAIRS;

  // Decoration. Pools double as light sources, so they are also level design.
  const pools = [];
  for (const r of rooms){
    if (r === start) continue;
    if (rng() < 0.55){
      const n = 1 + ((rng()*3)|0);
      for (let i = 0; i < n; i++){
        const x = r.x + ((rng()*r.w)|0), y = r.y + ((rng()*r.h)|0);
        if (grid[idx(x,y)] === T.FLOOR){ grid[idx(x,y)] = T.POOL; pools.push({x:x,y:y}); }
      }
    }
    const decor = (rng()*3)|0;
    for (let i = 0; i < decor; i++){
      const x = r.x + ((rng()*r.w)|0), y = r.y + ((rng()*r.h)|0);
      if (grid[idx(x,y)] === T.FLOOR && !(x === stairs.x && y === stairs.y)){
        grid[idx(x,y)] = rng() < 0.65 ? T.RUBBLE : T.BONES;
      }
    }
  }

  // Populate.
  const enemies = [], items = [];
  const pool = ['husk','husk','cultist'];
  if (depth >= 3) pool.push('wraith');
  if (depth >= 5) pool.push('wraith','cultist');

  if (isBoss){
    enemies.push(makeEnemy('ossuary', rooms[0].cx, rooms[0].cy - 2, depth));
    for (let i = 0; i < 3 + ((depth/5)|0); i++){
      const x = rooms[0].x + 1 + ((rng()*(rooms[0].w-2))|0);
      const y = rooms[0].y + 1 + ((rng()*(rooms[0].h-2))|0);
      if (grid[idx(x,y)] !== T.WALL) enemies.push(makeEnemy('husk', x, y, depth));
    }
    // Boss floors hide the stairs beneath the throne: they appear on kill.
  } else {
    for (const r of rooms){
      if (r === start) continue;
      const span  = 1 + Math.min(1.6, depth * 0.11);
      const count = 1 + ((rng() * span) | 0);
      for (let i = 0; i < count; i++){
        const x = r.x + ((rng()*r.w)|0), y = r.y + ((rng()*r.h)|0);
        if (grid[idx(x,y)] === T.WALL) continue;
        if (x === stairs.x && y === stairs.y) continue;
        enemies.push(makeEnemy(pool[(rng()*pool.length)|0], x, y, depth));
      }
    }
  }

  for (const r of rooms){
    if (r === start) continue;
    if (rng() < 0.62){
      const x = r.x + ((rng()*r.w)|0), y = r.y + ((rng()*r.h)|0);
      if (grid[idx(x,y)] !== T.WALL) items.push({ kind:'shard', x:x, y:y, amount: 2 + ((rng()*(3+depth))|0) });
    }
    if (rng() < 0.30){
      const x = r.x + ((rng()*r.w)|0), y = r.y + ((rng()*r.h)|0);
      if (grid[idx(x,y)] !== T.WALL) items.push({ kind:'flask', x:x, y:y });
    }
  }

  // Deterministic per-tile art variants, cached once.
  const variant = new Uint8Array(MAP_W * MAP_H);
  const vr = mulberry32(seed ^ 0x9E3779B9);
  for (let i = 0; i < variant.length; i++) variant[i] = (vr()*4)|0;

  return {
    grid: grid, variant: variant, rooms: rooms, start: startPos,
    stairs: stairs, pools: pools, enemies: enemies, items: items,
    isBoss: isBoss, stairsHidden: isBoss
  };
}

/* =====================================================================
   6. ENEMIES
   ===================================================================== */
const ETYPE = {
  husk: {
    name:'Skittering Husk', sprite:'husk', hp:15, dmg:4, armor:0,
    speed:2, aggro:7, shard:[1,3], erratic:0.28
  },
  cultist: {
    name:'Gloom Cultist', sprite:'cultist', hp:22, dmg:6, armor:1,
    speed:1, aggro:9, shard:[2,5], ranged:true, range:5, castChance:0.45
  },
  wraith: {
    name:'Shadow Wraith', sprite:'wraith', hp:28, dmg:10, armor:2,
    speed:1, aggro:10, shard:[4,7], phase:true
  },
  ossuary: {
    name:'The Crowned Ossuary', sprite:'boss', hp:95, dmg:11, armor:2,
    speed:1, aggro:20, shard:[28,45], boss:true, big:true, summonEvery:6
  }
};

let ENTITY_UID = 1;
function makeEnemy(type, x, y, depth){
  const base = ETYPE[type];
  const hpScale  = 1 + 0.19 * (depth - 1);
  const dmgScale = 1 + 0.13 * (depth - 1);
  const hp = Math.round(base.hp * hpScale);
  return {
    id: ENTITY_UID++, type: type, x: x, y: y, rx: x, ry: y,
    hp: hp, maxHp: hp,
    dmg: Math.max(1, Math.round(base.dmg * dmgScale)),
    armor: base.armor + Math.min(3, (depth / 6) | 0),
    frame: 0, atk: 0, hurt: 0, cd: 0, alive: true, dir: 1
  };
}

/* =====================================================================
   7. GAME STATE
   ===================================================================== */
const Game = {
  phase: 'title',            // title | playing | dead | descending
  depth: 1, maxDepth: 1,
  turn: 0, kills: 0, shards: 0,
  seed: 0, nonce: '',
  map: null,
  player: null,
  stats: null,
  visible: null, explored: null,
  particles: [], floaters: [],
  shake: 0, flash: 0, flashColor: '#000',
  log: [],
  seal: '', sealCopied: false, synced: false,
  overReason: '',
  descendFx: 0,
  time: 0
};

function newNonce(){
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[(Math.random()*chars.length)|0];
  return out;
}

function startRun(){
  Game.stats = derivedStats();
  Game.seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  Game.nonce = newNonce();
  Game.depth = 1; Game.maxDepth = 1;
  Game.turn = 0; Game.kills = 0; Game.shards = 0;
  Game.particles = []; Game.floaters = []; Game.log = [];
  Game.seal = ''; Game.sealCopied = false; Game.overReason = '';
  Game.player = {
    x:0, y:0, rx:0, ry:0,
    hp: Game.stats.maxHp, maxHp: Game.stats.maxHp,
    flasks: Game.stats.flasks,
    dashCd: 0, revives: Game.stats.revives,
    frame:0, atk:0, hurt:0, dir:1
  };
  buildFloorLevel();
  Game.phase = 'playing';
  pushLog('You descend into the Gloom.');
  Audio.setDepth(1);
  save();
}

function buildFloorLevel(){
  const m = genMap(Game.depth, (Game.seed + Game.depth * 7919) >>> 0);
  Game.map = m;
  Game.visible  = new Uint8Array(MAP_W * MAP_H);
  Game.explored = new Uint8Array(MAP_W * MAP_H);
  Game.player.x = m.start.x; Game.player.y = m.start.y;
  Game.player.rx = m.start.x; Game.player.ry = m.start.y;
  computeFOV();
  if (m.isBoss){ Audio.sfx('boss'); pushLog('Bone grinds on bone. Something wears a crown.'); }
}

function pushLog(text){
  Game.log.push(text);
  if (Game.log.length > 3) Game.log.shift();
}

/* =====================================================================
   8. FIELD OF VIEW
   Radial raycasting rather than shadowcasting: with a light radius under
   ~12 tiles the cost is negligible (it runs once per turn, not per frame)
   and the failure modes are far easier to reason about.
   ===================================================================== */
const FOV_RAYS = 200;
function computeFOV(){
  const vis = Game.visible, exp = Game.explored, g = Game.map.grid;
  vis.fill(0);
  const px0 = Game.player.x + 0.5, py0 = Game.player.y + 0.5;
  const R = Game.stats.light;
  vis[idx(Game.player.x, Game.player.y)] = 1;
  exp[idx(Game.player.x, Game.player.y)] = 1;

  for (let a = 0; a < FOV_RAYS; a++){
    const ang = (a / FOV_RAYS) * Math.PI * 2;
    const dx = Math.cos(ang) * 0.28, dy = Math.sin(ang) * 0.28;
    let cx = px0, cy = py0;
    const steps = Math.ceil(R / 0.28);
    for (let s = 0; s < steps; s++){
      cx += dx; cy += dy;
      const tx = cx | 0, ty = cy | 0;
      if (!inMap(tx,ty)) break;
      vis[idx(tx,ty)] = 1; exp[idx(tx,ty)] = 1;
      if (SOLID[g[idx(tx,ty)]]) break;
    }
  }
  // Raycasting can leave pinholes in walls bordering lit floor; patch them so
  // room outlines read as solid masonry instead of dotted lines.
  for (let y = 1; y < MAP_H-1; y++){
    for (let x = 1; x < MAP_W-1; x++){
      const i = idx(x,y);
      if (!SOLID[g[i]] || vis[i]) continue;
      const dx = x - Game.player.x, dy = y - Game.player.y;
      if (dx*dx + dy*dy > (R+1)*(R+1)) continue;
      if (vis[idx(x-1,y)] || vis[idx(x+1,y)] || vis[idx(x,y-1)] || vis[idx(x,y+1)]){
        vis[i] = 1; exp[i] = 1;
      }
    }
  }
}

function hasLOS(x0,y0,x1,y1){
  const g = Game.map.grid;
  let dx = Math.abs(x1-x0), dy = Math.abs(y1-y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0, guard = 0;
  while (guard++ < 200){
    if (x === x1 && y === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy){ err -= dy; x += sx; }
    if (e2 <  dx){ err += dx; y += sy; }
    if (!inMap(x,y)) return false;
    if (SOLID[g[idx(x,y)]] && !(x === x1 && y === y1)) return false;
  }
  return false;
}

/* =====================================================================
   9. TURN RESOLUTION
   ===================================================================== */
function passable(x,y,phase){
  if (!inMap(x,y)) return false;
  if (x === 0 || y === 0 || x === MAP_W-1 || y === MAP_H-1) return false;
  if (phase) return true;
  return !SOLID[Game.map.grid[idx(x,y)]];
}
function enemyAt(x,y){
  const list = Game.map.enemies;
  for (let i = 0; i < list.length; i++){
    const e = list[i];
    if (e.alive && e.x === x && e.y === y) return e;
  }
  return null;
}

function damageRoll(base, armor, critChance){
  const crit = Math.random() < (critChance || 0);
  let dmg = base + ((Math.random() * 3) | 0);
  if (crit) dmg = Math.round(dmg * 2);
  return { dmg: Math.max(1, dmg - armor), crit: crit };
}

function playerAttack(e){
  const p = Game.player;
  const r = damageRoll(Game.stats.dmg, e.armor, Game.stats.crit);
  e.hp -= r.dmg; e.hurt = 1;
  p.atk = 1;
  Audio.sfx('attack');
  addFloater(e.x, e.y, String(r.dmg), r.crit ? '#e0455f' : '#d9d2b8', r.crit);
  spark(e.x, e.y, r.crit ? '#e0455f' : '#8dffc0', r.crit ? 16 : 9);
  Game.shake = Math.max(Game.shake, r.crit ? 4.5 : 2.2);

  if (Game.stats.lifesteal > 0){
    const heal = Math.max(1, Math.round(r.dmg * Game.stats.lifesteal));
    const before = p.hp;
    p.hp = Math.min(p.maxHp, p.hp + heal);
    if (p.hp > before) addFloater(p.x, p.y, '+' + (p.hp - before), '#39ff88', false);
  }
  if (e.hp <= 0) killEnemy(e);
}

function killEnemy(e){
  e.alive = false;
  Game.kills++;
  Audio.sfx('kill');
  const base = ETYPE[e.type];
  const roll = base.shard[0] + ((Math.random() * (base.shard[1] - base.shard[0] + 1)) | 0);
  const gain = Math.max(1, Math.round(roll * Game.stats.shardMul));
  Game.shards += gain;
  addFloater(e.x, e.y, '+' + gain, '#39ff88', false);
  puff(e.x, e.y, base.boss ? '#e0b34a' : '#4a2c7a', base.boss ? 40 : 14);
  if (base.boss){
    Game.map.grid[idx(Game.map.stairs.x, Game.map.stairs.y)] = T.STAIRS;
    Game.map.stairsHidden = false;
    Game.shake = 9;
    pushLog('The crown falls. The way down is open.');
    Audio.sfx('stairs');
  }
}

function hurtPlayer(amount, source){
  const p = Game.player;
  const r = damageRoll(amount, Game.stats.armor, 0.05);
  p.hp -= r.dmg; p.hurt = 1;
  Game.shake = Math.max(Game.shake, 5);
  Game.flash = 0.5; Game.flashColor = '#a01130';
  Audio.sfx('hurt');
  addFloater(p.x, p.y, '-' + r.dmg, '#e0455f', false);
  if (source) pushLog(ETYPE[source].name + ' strikes you for ' + r.dmg + '.');
  if (p.hp <= 0){
    if (p.revives > 0){
      p.revives--;
      p.hp = Math.max(1, Math.round(p.maxHp * Game.stats.revivePct));
      Game.flash = 1; Game.flashColor = '#39ff88';
      Audio.sfx('revive');
      pushLog('Second Breath. Death loosens its grip.');
      puff(p.x, p.y, '#39ff88', 30);
    } else {
      endRun('slain in the deep');
    }
  }
}

function pickUp(){
  const p = Game.player, items = Game.map.items;
  for (let i = items.length - 1; i >= 0; i--){
    const it = items[i];
    if (it.x !== p.x || it.y !== p.y) continue;
    if (it.kind === 'shard'){
      const gain = Math.max(1, Math.round(it.amount * Game.stats.shardMul));
      Game.shards += gain;
      addFloater(p.x, p.y, '+' + gain, '#39ff88', false);
      Audio.sfx('shard');
      spark(p.x, p.y, '#39ff88', 10);
    } else {
      p.flasks++;
      addFloater(p.x, p.y, 'flask', '#e0455f', false);
      Audio.sfx('flask');
    }
    items.splice(i,1);
  }
}

function tryMove(dx, dy){
  if (Game.phase !== 'playing') return;
  const p = Game.player;
  if (dx !== 0) p.dir = dx;
  const nx = p.x + dx, ny = p.y + dy;
  const target = enemyAt(nx, ny);
  if (target){ playerAttack(target); endPlayerTurn(); return; }
  if (!passable(nx, ny, false)){
    Audio.sfx('bump');
    Game.shake = Math.max(Game.shake, 1.0);
    return;
  }
  p.x = nx; p.y = ny;
  pickUp();
  if (Game.map.grid[idx(nx,ny)] === T.STAIRS){ descend(); return; }
  endPlayerTurn();
}

function tryDash(){
  if (Game.phase !== 'playing') return;
  const p = Game.player;
  if (!Game.stats.hasDash){ pushLog('You have not learned to step through shadow.'); return; }
  if (p.dashCd > 0){ pushLog('Shadow Dash is still gathering.'); return; }
  const dx = lastDir.x, dy = lastDir.y;
  if (dx === 0 && dy === 0) return;

  let moved = 0, struck = false;
  for (let step = 0; step < 2; step++){
    const nx = p.x + dx, ny = p.y + dy;
    const e = enemyAt(nx, ny);
    if (e && !struck){
      const r = damageRoll(Game.stats.dmg + 6, e.armor, 0.25);
      e.hp -= r.dmg; e.hurt = 1; struck = true;
      addFloater(e.x, e.y, String(r.dmg), '#e0455f', true);
      spark(e.x, e.y, '#7a52c0', 18);
      if (e.hp <= 0) killEnemy(e);
      else break;
    }
    if (!passable(nx, ny, false)) break;
    if (enemyAt(nx, ny)) break;
    p.x = nx; p.y = ny; moved++;
    trail(p.x, p.y);
    pickUp();
    if (Game.map.grid[idx(p.x,p.y)] === T.STAIRS){ descend(); return; }
  }
  if (moved === 0 && !struck){ Audio.sfx('bump'); return; }
  p.dashCd = Game.stats.dashCdMax;
  Audio.sfx('dash');
  Game.shake = Math.max(Game.shake, 3);
  endPlayerTurn();
}

function drinkFlask(){
  if (Game.phase !== 'playing') return;
  const p = Game.player;
  if (p.flasks <= 0){ pushLog('The satchel is empty.'); return; }
  if (p.hp >= p.maxHp){ pushLog('You are already whole.'); return; }
  p.flasks--;
  const heal = Math.round(p.maxHp * 0.34);
  const before = p.hp;
  p.hp = Math.min(p.maxHp, p.hp + heal);
  addFloater(p.x, p.y, '+' + (p.hp - before), '#39ff88', false);
  Audio.sfx('flask');
  puff(p.x, p.y, '#a01130', 12);
  endPlayerTurn();
}

function wait(){
  if (Game.phase !== 'playing') return;
  endPlayerTurn();
}

function descend(){
  Game.depth++;
  Game.maxDepth = Math.max(Game.maxDepth, Game.depth);
  const bonus = Math.max(1, Math.round(Game.depth * 3 * Game.stats.shardMul));
  Game.shards += bonus;
  const p = Game.player;
  p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.12));
  buildFloorLevel();
  Game.descendFx = 1;
  Game.flash = 0.7; Game.flashColor = '#4a2c7a';
  Audio.sfx('stairs');
  Audio.setDepth(Game.depth);
  pushLog('Depth ' + roman(Game.depth) + '. +' + bonus + ' shards for the descent.');
  save(true);
}

function endPlayerTurn(){
  Game.turn++;
  const p = Game.player;
  if (p.dashCd > 0) p.dashCd--;
  enemiesAct();
  computeFOV();
  if (Game.phase === 'playing') save();
}

function stepToward(e, tx, ty, phase){
  const dx = sign(tx - e.x), dy = sign(ty - e.y);
  const opts = [];
  if (Math.abs(tx - e.x) >= Math.abs(ty - e.y)){
    if (dx) opts.push([dx,0]);
    if (dy) opts.push([0,dy]);
  } else {
    if (dy) opts.push([0,dy]);
    if (dx) opts.push([dx,0]);
  }
  opts.push([0,1],[0,-1],[1,0],[-1,0]);
  for (const o of opts){
    const nx = e.x + o[0], ny = e.y + o[1];
    if (!passable(nx, ny, phase)) continue;
    if (enemyAt(nx, ny)) continue;
    if (nx === Game.player.x && ny === Game.player.y) continue;
    e.x = nx; e.y = ny;
    if (o[0]) e.dir = o[0];
    return true;
  }
  return false;
}

function enemiesAct(){
  const p = Game.player;
  const list = Game.map.enemies;
  for (let i = 0; i < list.length; i++){
    const e = list[i];
    if (!e.alive) continue;
    if (Game.phase !== 'playing') return;
    const base = ETYPE[e.type];
    const dist = Math.abs(e.x - p.x) + Math.abs(e.y - p.y);
    const sees = dist <= base.aggro && (base.phase || hasLOS(e.x, e.y, p.x, p.y));

    if (base.boss && base.summonEvery && Game.turn % base.summonEvery === 0){
      for (const d of [[1,0],[-1,0],[0,1],[0,-1]]){
        const sx = e.x + d[0]*2, sy = e.y + d[1]*2;
        if (passable(sx,sy,false) && !enemyAt(sx,sy) && !(sx===p.x && sy===p.y)){
          list.push(makeEnemy('husk', sx, sy, Game.depth));
          puff(sx, sy, '#8f8768', 12);
          break;
        }
      }
    }

    const acts = base.speed || 1;
    for (let a = 0; a < acts; a++){
      if (Game.phase !== 'playing') return;
      const adjacent = Math.abs(e.x - p.x) + Math.abs(e.y - p.y) === 1;
      if (adjacent){
        e.atk = 1;
        hurtPlayer(e.dmg, e.type);
        break;
      }
      if (!sees){
        if (Math.random() < 0.25) stepToward(e, e.x + ((Math.random()*3|0)-1), e.y + ((Math.random()*3|0)-1), base.phase);
        break;
      }
      if (base.ranged && dist <= base.range && hasLOS(e.x,e.y,p.x,p.y) && Math.random() < base.castChance){
        e.atk = 1;
        bolt(e.x, e.y, p.x, p.y, '#39ff88');
        hurtPlayer(Math.round(e.dmg * 0.8), e.type);
        break;
      }
      if (base.erratic && Math.random() < base.erratic){
        stepToward(e, e.x + ((Math.random()*3|0)-1), e.y + ((Math.random()*3|0)-1), base.phase);
      } else {
        stepToward(e, p.x, p.y, base.phase);
      }
    }
  }
  // Reap the dead so the array does not grow without bound over a long run.
  Game.map.enemies = list.filter(e => e.alive);
}

/* =====================================================================
   10. EFFECTS
   ===================================================================== */
function addFloater(x,y,text,color,big){
  Game.floaters.push({ x:x+0.5, y:y, text:text, color:color, life:1, big:!!big });
  if (Game.floaters.length > 24) Game.floaters.shift();
}
function spark(x,y,color,n){
  for (let i = 0; i < n; i++){
    const a = Math.random() * Math.PI * 2, s = 1.4 + Math.random() * 3.4;
    Game.particles.push({ x:(x+0.5)*TILE, y:(y+0.5)*TILE,
      vx:Math.cos(a)*s, vy:Math.sin(a)*s, life:1, decay:2.6, color:color, size:1 });
  }
}
function puff(x,y,color,n){
  for (let i = 0; i < n; i++){
    const a = Math.random() * Math.PI * 2, s = 0.4 + Math.random() * 1.7;
    Game.particles.push({ x:(x+0.5)*TILE, y:(y+0.5)*TILE,
      vx:Math.cos(a)*s, vy:Math.sin(a)*s - 0.5, life:1, decay:1.1, color:color, size:2 });
  }
}
function trail(x,y){
  for (let i = 0; i < 6; i++){
    Game.particles.push({ x:(x+0.5)*TILE + (Math.random()*10-5), y:(y+0.5)*TILE + (Math.random()*10-5),
      vx:0, vy:-0.3, life:1, decay:2.0, color:'#7a52c0', size:2 });
  }
}
function bolt(x0,y0,x1,y1,color){
  const steps = 12;
  for (let i = 0; i <= steps; i++){
    const t = i / steps;
    Game.particles.push({
      x: lerp((x0+0.5)*TILE, (x1+0.5)*TILE, t),
      y: lerp((y0+0.5)*TILE, (y1+0.5)*TILE, t),
      vx:0, vy:0, life:1, decay:3.4, color:color, size:1
    });
  }
}
function updateEffects(dt){
  for (let i = Game.particles.length - 1; i >= 0; i--){
    const p = Game.particles[i];
    p.x += p.vx * dt * 60 * 0.5;
    p.y += p.vy * dt * 60 * 0.5;
    p.vy += dt * 3;
    p.life -= dt * p.decay;
    if (p.life <= 0) Game.particles.splice(i,1);
  }
  for (let i = Game.floaters.length - 1; i >= 0; i--){
    const f = Game.floaters[i];
    f.y -= dt * 1.1;
    f.life -= dt * 0.85;
    if (f.life <= 0) Game.floaters.splice(i,1);
  }
  Game.shake = Math.max(0, Game.shake - dt * 22);
  Game.flash = Math.max(0, Game.flash - dt * 2.4);
  Game.descendFx = Math.max(0, Game.descendFx - dt * 1.5);
}

/* =====================================================================
   11. RUN TERMINATION & THE SEAL BRIDGE
   ===================================================================== */
function makeSeal(){
  const payload = { n: Game.nonce, s: Game.shards, d: Game.maxDepth, k: Game.kills, t: Game.turn };
  const json = JSON.stringify(payload);
  let b64 = btoa(unescape(encodeURIComponent(json)));
  b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sum = fnv1a(CFG.sealSalt + b64).toString(16);
  const pad = '00000000'.slice(sum.length) + sum;
  return CFG.sealPrefix + '.' + b64 + '.' + pad;
}

function copyText(text){
  try {
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(()=>{ Game.sealCopied = true; }).catch(()=>legacyCopy(text));
      return;
    }
  } catch(e){}
  legacyCopy(text);
}
function legacyCopy(text){
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    Game.sealCopied = document.execCommand('copy');
    document.body.removeChild(ta);
  } catch(e){ Game.sealCopied = false; }
}

/* Best-effort auto-fill of the Sanctum's seal field in the parent document.
   Streamlit renders components in a same-origin srcdoc iframe, so this
   usually succeeds; every failure mode is caught and falls back to the
   clipboard plus the on-screen seal. React controlled inputs ignore a plain
   `value =` assignment, hence the native setter. */
function trySyncToParent(seal){
  try {
    const doc = window.parent.document;
    if (!doc) return false;
    let field = doc.querySelector('input[aria-label="Run Seal"]');
    if (!field){
      const candidates = doc.querySelectorAll('section[data-testid="stSidebar"] input[type="text"]');
      if (candidates.length) field = candidates[0];
    }
    if (!field) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.parent.HTMLInputElement.prototype, 'value').set;
    setter.call(field, seal);
    field.dispatchEvent(new window.parent.Event('input', { bubbles: true }));
    field.dispatchEvent(new window.parent.Event('change', { bubbles: true }));
    field.dispatchEvent(new window.parent.KeyboardEvent('keydown', {
      key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true }));
    return true;
  } catch(e){ return false; }
}

function endRun(reason){
  if (Game.phase === 'dead') return;
  Game.phase = 'dead';
  Game.overReason = reason;
  Game.seal = makeSeal();
  Game.sealCopied = false;
  Game.synced = trySyncToParent(Game.seal);
  copyText(Game.seal);
  Audio.sfx('death');
  Game.shake = 10;
  Game.flash = 1; Game.flashColor = '#a01130';
  clearSave();
}

/* =====================================================================
   12. PERSISTENCE
   ===================================================================== */
let lastSave = 0;
function save(force){
  const now = performance.now();
  if (!force && now - lastSave < 250) return;
  lastSave = now;
  try {
    if (!window.localStorage) return;
    const m = Game.map;
    const blob = {
      v: 1, buildId: CFG.buildId,
      depth: Game.depth, maxDepth: Game.maxDepth,
      turn: Game.turn, kills: Game.kills, shards: Game.shards,
      seed: Game.seed, nonce: Game.nonce,
      player: Game.player,
      grid: Array.from(m.grid), variant: Array.from(m.variant),
      explored: Array.from(Game.explored),
      stairs: m.stairs, pools: m.pools, isBoss: m.isBoss, stairsHidden: m.stairsHidden,
      enemies: m.enemies.filter(e => e.alive),
      items: m.items,
      log: Game.log
    };
    window.localStorage.setItem(CFG.storageKey, JSON.stringify(blob));
  } catch(e){ /* quota or privacy mode — runs simply become session-only */ }
}
function clearSave(){
  try { if (window.localStorage) window.localStorage.removeItem(CFG.storageKey); } catch(e){}
}
function load(){
  try {
    if (!window.localStorage) return false;
    const raw = window.localStorage.getItem(CFG.storageKey);
    if (!raw) return false;
    const b = JSON.parse(raw);
    if (!b || b.v !== 1 || !b.player) return false;

    Game.stats = derivedStats();          // re-derive: upgrades may have changed
    Game.depth = b.depth; Game.maxDepth = b.maxDepth;
    Game.turn = b.turn; Game.kills = b.kills; Game.shards = b.shards;
    Game.seed = b.seed; Game.nonce = b.nonce || newNonce();
    Game.player = b.player;
    Game.player.maxHp = Game.stats.maxHp;                       // grant new vitality
    Game.player.hp = clamp(Game.player.hp, 1, Game.stats.maxHp);
    Game.player.revives = Math.max(Game.player.revives | 0, 0);
    Game.explored = Uint8Array.from(b.explored);
    Game.visible  = new Uint8Array(MAP_W * MAP_H);
    Game.map = {
      grid: Uint8Array.from(b.grid), variant: Uint8Array.from(b.variant),
      rooms: [], start: { x: b.player.x, y: b.player.y },
      stairs: b.stairs, pools: b.pools || [],
      enemies: b.enemies || [], items: b.items || [],
      isBoss: !!b.isBoss, stairsHidden: !!b.stairsHidden
    };
    for (const e of Game.map.enemies){
      e.rx = e.x; e.ry = e.y; e.alive = true;
      e.atk = 0; e.hurt = 0; e.frame = 0;
      ENTITY_UID = Math.max(ENTITY_UID, (e.id | 0) + 1);
    }
    Game.log = b.log || [];
    Game.phase = 'playing';
    computeFOV();
    Audio.setDepth(Game.depth);
    return true;
  } catch(e){ return false; }
}

/* =====================================================================
   13. RENDERING
   ===================================================================== */
const scene = document.getElementById('scene');
const textC = document.getElementById('text');
const stage = document.getElementById('stage');
const frame = document.getElementById('frame');
const sx = scene.getContext('2d');
const tx = textC.getContext('2d');
sx.imageSmoothingEnabled = false;

const light = mkc(LW, LH);
const glow  = mkc(LW, LH);

let TS = 1;                 // base-units -> text-canvas-pixels
let stairsBeacon = null;    // set during lighting, reused by the glow pass
let camX = 0, camY = 0;

function resize(){
  const availW = stage.clientWidth  || window.innerWidth;
  const availH = stage.clientHeight || window.innerHeight;
  let s = Math.min(availW / BASE_W, availH / BASE_H);
  s = Math.max(s, 0.35);
  const cssW = Math.max(1, Math.floor(BASE_W * s));
  const cssH = Math.max(1, Math.floor(BASE_H * s));
  frame.style.width = cssW + 'px'; frame.style.height = cssH + 'px';
  scene.style.width = cssW + 'px'; scene.style.height = cssH + 'px';
  textC.style.width = cssW + 'px'; textC.style.height = cssH + 'px';
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  textC.width  = Math.floor(cssW * dpr);
  textC.height = Math.floor(cssH * dpr);
  TS = (cssW * dpr) / BASE_W;
  tx.imageSmoothingEnabled = true;
}
window.addEventListener('resize', resize);

/* --- UI geometry, all defined in base coordinates ------------------- */
const PADX = 8, PADY = BASE_H - 98, CELL = 28, GAP = 2;
const UI = {
  up:    { x: PADX + CELL + GAP,       y: PADY,                    w: CELL, h: CELL, id:'up' },
  left:  { x: PADX,                    y: PADY + CELL + GAP,       w: CELL, h: CELL, id:'left' },
  wait:  { x: PADX + CELL + GAP,       y: PADY + CELL + GAP,       w: CELL, h: CELL, id:'wait' },
  right: { x: PADX + (CELL+GAP)*2,     y: PADY + CELL + GAP,       w: CELL, h: CELL, id:'right' },
  down:  { x: PADX + CELL + GAP,       y: PADY + (CELL+GAP)*2,     w: CELL, h: CELL, id:'down' },
  dash:  { x: BASE_W - 46,             y: BASE_H - 96,             w: 38,   h: 38,   id:'dash' },
  flask: { x: BASE_W - 46,             y: BASE_H - 52,             w: 38,   h: 38,   id:'flask' },
  mute:  { x: BASE_W - 24,             y: 4,                       w: 20,   h: 20,   id:'mute' },
  quit:  { x: BASE_W - 48,             y: 4,                       w: 20,   h: 20,   id:'quit' }
};
const OVL = {
  primary:  { x: 38, y: 300, w: 180, h: 34, id:'primary' },
  copy:     { x: 38, y: 344, w: 180, h: 28, id:'copy' }
};
const held = {};
let lastDir = { x: 0, y: 1 };

function hit(r, x, y){ return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

function drawPanel(g, r, active, tint){
  g.globalAlpha = active ? 0.92 : 0.62;
  g.fillStyle = active ? (tint || '#4a2c7a') : '#140f22';
  g.fillRect(r.x, r.y, r.w, r.h);
  g.globalAlpha = 1;
  g.fillStyle = active ? '#8dffc0' : '#3a2a58';
  g.fillRect(r.x, r.y, r.w, 1);
  g.fillRect(r.x, r.y + r.h - 1, r.w, 1);
  g.fillRect(r.x, r.y, 1, r.h);
  g.fillRect(r.x + r.w - 1, r.y, 1, r.h);
}
function drawArrow(g, r, dx, dy, color){
  const cx = r.x + (r.w >> 1), cy = r.y + (r.h >> 1);
  g.fillStyle = color;
  for (let i = 0; i < 5; i++){
    const len = 9 - i * 2;
    if (dy !== 0){
      g.fillRect(cx - (len >> 1), cy + dy * (i - 2) - (dy > 0 ? 0 : 0), len, 1);
    } else {
      g.fillRect(cx + dx * (i - 2), cy - (len >> 1), 1, len);
    }
  }
}

function render(dt){
  Game.time += dt;
  const p = Game.player;
  const animK = 1 - Math.exp(-dt * MOVE_SMOOTH);

  if (Game.phase !== 'title'){
    p.rx = lerp(p.rx, p.x, animK);
    p.ry = lerp(p.ry, p.y, animK);
    p.atk  = Math.max(0, p.atk  - dt * 5);
    p.hurt = Math.max(0, p.hurt - dt * 3);
    for (const e of Game.map.enemies){
      e.rx = lerp(e.rx, e.x, animK);
      e.ry = lerp(e.ry, e.y, animK);
      e.atk  = Math.max(0, e.atk  - dt * 5);
      e.hurt = Math.max(0, e.hurt - dt * 3);
    }
  }

  sx.setTransform(1,0,0,1,0,0);
  sx.fillStyle = '#05040a';
  sx.fillRect(0,0,BASE_W,BASE_H);
  tx.setTransform(TS,0,0,TS,0,0);
  tx.clearRect(0,0,BASE_W,BASE_H);

  if (Game.phase === 'title'){ drawTitle(); return; }

  // Camera with clamped bounds and a decaying shake.
  const shakeX = (Math.random()*2-1) * Game.shake;
  const shakeY = (Math.random()*2-1) * Game.shake;
  camX = clamp(p.rx * TILE + TILE/2 - BASE_W/2, 0, MAP_W*TILE - BASE_W) + shakeX;
  camY = clamp(p.ry * TILE + TILE/2 - BASE_H/2, 0, MAP_H*TILE - BASE_H) + shakeY;

  drawWorld();
  drawLighting();
  drawParticles();
  drawFloaters();

  if (Game.flash > 0){
    sx.globalAlpha = Game.flash * 0.5;
    sx.fillStyle = Game.flashColor;
    sx.fillRect(0,0,BASE_W,BASE_H);
    sx.globalAlpha = 1;
  }
  if (Game.descendFx > 0){
    sx.globalAlpha = Game.descendFx * 0.85;
    sx.fillStyle = '#05040a';
    sx.fillRect(0,0,BASE_W,BASE_H);
    sx.globalAlpha = 1;
  }

  drawHUD();
  drawControls();
  if (Game.phase === 'dead') drawDeath();
}

function tileImage(t, i){
  switch(t){
    case T.WALL:   return ATLAS.wall[Game.map.variant[i] & 3];
    case T.POOL:   return ATLAS.pool[((Game.time * 4) | 0) % 3];
    case T.STAIRS: return ATLAS.stairs;
    case T.RUBBLE: return ATLAS.rubble[Game.map.variant[i] % 3];
    case T.BONES:  return ATLAS.bones[0];
    default:       return ATLAS.floor[Game.map.variant[i] & 3];
  }
}

function drawWorld(){
  const g = Game.map.grid, exp = Game.explored, vis = Game.visible;
  const x0 = Math.max(0, (camX / TILE) | 0);
  const y0 = Math.max(0, (camY / TILE) | 0);
  const x1 = Math.min(MAP_W - 1, x0 + (BASE_W / TILE) + 1);
  const y1 = Math.min(MAP_H - 1, y0 + (BASE_H / TILE) + 1);

  for (let y = y0; y <= y1; y++){
    for (let x = x0; x <= x1; x++){
      const i = idx(x,y);
      if (!exp[i]) continue;
      const t = g[i];
      // A decorated tile still needs floor beneath it.
      if (t === T.RUBBLE || t === T.BONES){
        sx.drawImage(ATLAS.floor[Game.map.variant[i] & 3],
          Math.round(x*TILE - camX), Math.round(y*TILE - camY));
      }
      sx.drawImage(tileImage(t, i),
        Math.round(x*TILE - camX), Math.round(y*TILE - camY));
    }
  }

  // Items, then enemies, then the player, so the player always reads on top.
  for (const it of Game.map.items){
    if (!exp[idx(it.x,it.y)]) continue;
    const img = it.kind === 'shard'
      ? ATLAS.shard[((Game.time*2.5)|0) % 2]
      : ATLAS.flask[((Game.time*2.0)|0) % 2];
    sx.drawImage(img, Math.round(it.x*TILE - camX), Math.round(it.y*TILE - camY));
  }

  const p = Game.player;
  for (const e of Game.map.enemies){
    const seen = vis[idx(e.x,e.y)];
    const dist = Math.abs(e.x - p.x) + Math.abs(e.y - p.y);
    const sensed = !seen && Game.stats.sense > 0 && dist <= Game.stats.sense;
    if (!e.alive){ continue; }
    if (!seen && !sensed) continue;

    const base = ETYPE[e.type];
    const dx = Math.round(e.rx*TILE - camX);
    const dy = Math.round(e.ry*TILE - camY);

    if (sensed){
      // A sensed but unseen enemy is a warning, not a target: show a pulse.
      const a = 0.35 + 0.25 * Math.sin(Game.time * 6);
      sx.globalAlpha = a;
      sx.fillStyle = '#e0455f';
      sx.fillRect(dx + 6, dy + 5, 4, 4);
      sx.fillRect(dx + 7, dy + 4, 2, 6);
      sx.fillRect(dx + 5, dy + 6, 6, 2);
      sx.globalAlpha = 1;
      continue;
    }

    const frameI = (((Game.time * 3) | 0) + e.id) % 2;
    const img = ATLAS.ent[base.sprite][frameI];
    const lunge = e.atk > 0 ? 2 : 0;
    const ox = lunge * sign(p.x - e.x), oy = lunge * sign(p.y - e.y);

    if (e.hurt > 0){ sx.globalAlpha = 0.55 + 0.45 * Math.sin(Game.time * 40); }
    if (base.big) sx.drawImage(img, dx - 8 + ox, dy - 16 + oy);
    else          sx.drawImage(img, dx + ox, dy + oy);
    sx.globalAlpha = 1;

    if (e.hp < e.maxHp){
      const w = base.big ? 24 : 12;
      const bx = dx + ((base.big ? 16 : 8) - w/2);
      const by = dy - (base.big ? 20 : 3);
      sx.fillStyle = '#0b0912'; sx.fillRect(bx - 1, by - 1, w + 2, 4);
      sx.fillStyle = '#3a1020'; sx.fillRect(bx, by, w, 2);
      sx.fillStyle = base.boss ? '#e0b34a' : '#c8203f';
      sx.fillRect(bx, by, Math.max(1, Math.round(w * (e.hp / e.maxHp))), 2);
    }
  }

  const pframe = p.atk > 0 ? 2 : (((Game.time * 2.6) | 0) % 2);
  const pdx = Math.round(p.rx*TILE - camX);
  const pdy = Math.round(p.ry*TILE - camY);
  if (p.hurt > 0) sx.globalAlpha = 0.5 + 0.5 * Math.sin(Game.time * 40);
  const flip = p.dir < 0;
  if (flip){
    sx.save();
    sx.translate(pdx + TILE, pdy);
    sx.scale(-1, 1);
    sx.drawImage(ATLAS.ent.player[pframe], 0, 0);
    sx.restore();
  } else {
    sx.drawImage(ATLAS.ent.player[pframe], pdx, pdy);
  }
  sx.globalAlpha = 1;
}

function drawLighting(){
  const lg = light.x;
  lg.setTransform(1,0,0,1,0,0);
  lg.globalCompositeOperation = 'source-over';
  lg.fillStyle = '#000';
  lg.fillRect(0,0,LW,LH);
  lg.globalCompositeOperation = 'destination-out';

  // Remembered geometry stays faintly legible so the map builds in the mind.
  const exp = Game.explored;
  const x0 = Math.max(0, (camX / TILE) | 0);
  const y0 = Math.max(0, (camY / TILE) | 0);
  const x1 = Math.min(MAP_W - 1, x0 + (BASE_W / TILE) + 1);
  const y1 = Math.min(MAP_H - 1, y0 + (BASE_H / TILE) + 1);
  lg.fillStyle = 'rgba(0,0,0,0.15)';
  for (let y = y0; y <= y1; y++){
    for (let x = x0; x <= x1; x++){
      if (!exp[idx(x,y)]) continue;
      lg.fillRect((x*TILE - camX)/2, (y*TILE - camY)/2, TILE/2 + 1, TILE/2 + 1);
    }
  }

  // Torch flicker: two out-of-phase sines read as organic without noise cost.
  const p = Game.player;
  const flick = 1 + Math.sin(Game.time * 7.3) * 0.03 + Math.sin(Game.time * 2.1) * 0.045;
  const R = Game.stats.light * TILE * flick;
  const cx = (p.rx * TILE + TILE/2 - camX) / 2;
  const cy = (p.ry * TILE + TILE/2 - camY) / 2;
  punch(lg, cx, cy, R/2, 1.0);

  for (const pool of Game.map.pools){
    if (!Game.explored[idx(pool.x, pool.y)]) continue;
    const px2 = (pool.x*TILE + TILE/2 - camX) / 2;
    const py2 = (pool.y*TILE + TILE/2 - camY) / 2;
    if (px2 < -30 || py2 < -30 || px2 > LW+30 || py2 > LH+30) continue;
    const pr = (2.6 + Math.sin(Game.time*2 + pool.x) * 0.25) * TILE / 2;
    punch(lg, px2, py2, pr, 0.85);
  }

  // The way down bleeds light through unexplored dark. This is deliberate:
  // it replaces a minimap or compass with a diegetic beacon, so wayfinding
  // costs the player attention rather than UI real estate.
  if (!Game.map.stairsHidden){
    const st = Game.map.stairs;
    const stx = (st.x*TILE + TILE/2 - camX) / 2;
    const sty = (st.y*TILE + TILE/2 - camY) / 2;
    if (stx > -40 && sty > -40 && stx < LW+40 && sty < LH+40){
      const sr = (3.1 + Math.sin(Game.time*1.7) * 0.35) * TILE / 2;
      punch(lg, stx, sty, sr, 0.52);
      stairsBeacon = { x: stx, y: sty, r: sr };
    } else stairsBeacon = null;
  } else stairsBeacon = null;

  sx.imageSmoothingEnabled = true;
  sx.drawImage(light.c, 0, 0, BASE_W, BASE_H);
  sx.imageSmoothingEnabled = false;

  // Additive colour wash: green from the pools, violet around the player.
  const gg = glow.x;
  gg.setTransform(1,0,0,1,0,0);
  gg.clearRect(0,0,LW,LH);
  gg.globalCompositeOperation = 'source-over';
  for (const pool of Game.map.pools){
    if (!Game.visible[idx(pool.x, pool.y)]) continue;
    const px2 = (pool.x*TILE + TILE/2 - camX) / 2;
    const py2 = (pool.y*TILE + TILE/2 - camY) / 2;
    if (px2 < -30 || py2 < -30 || px2 > LW+30 || py2 > LH+30) continue;
    const grad = gg.createRadialGradient(px2,py2,0,px2,py2,22);
    grad.addColorStop(0,'rgba(57,255,136,0.55)');
    grad.addColorStop(1,'rgba(57,255,136,0)');
    gg.fillStyle = grad;
    gg.fillRect(px2-22, py2-22, 44, 44);
  }
  if (stairsBeacon){
    const sb = stairsBeacon, rr = sb.r * 1.5;
    const sg = gg.createRadialGradient(sb.x,sb.y,0,sb.x,sb.y,rr);
    sg.addColorStop(0,'rgba(122,82,192,0.50)');
    sg.addColorStop(0.5,'rgba(74,44,122,0.20)');
    sg.addColorStop(1,'rgba(74,44,122,0)');
    gg.fillStyle = sg;
    gg.fillRect(sb.x-rr, sb.y-rr, rr*2, rr*2);
  }
  const pg = gg.createRadialGradient(cx,cy,0,cx,cy,R/2.4);
  pg.addColorStop(0,'rgba(122,82,192,0.30)');
  pg.addColorStop(0.6,'rgba(74,44,122,0.12)');
  pg.addColorStop(1,'rgba(74,44,122,0)');
  gg.fillStyle = pg;
  gg.fillRect(0,0,LW,LH);

  sx.globalCompositeOperation = 'lighter';
  sx.imageSmoothingEnabled = true;
  sx.globalAlpha = 0.85;
  sx.drawImage(glow.c, 0, 0, BASE_W, BASE_H);
  sx.globalAlpha = 1;
  sx.imageSmoothingEnabled = false;
  sx.globalCompositeOperation = 'source-over';
}

function punch(g, cx, cy, r, strength){
  if (r <= 0) return;
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0.00, 'rgba(0,0,0,' + strength + ')');
  grad.addColorStop(0.55, 'rgba(0,0,0,' + (strength * 0.80) + ')');
  grad.addColorStop(0.82, 'rgba(0,0,0,' + (strength * 0.32) + ')');
  grad.addColorStop(1.00, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(cx - r, cy - r, r * 2, r * 2);
}

function drawParticles(){
  for (const p of Game.particles){
    sx.globalAlpha = clamp(p.life, 0, 1);
    sx.fillStyle = p.color;
    sx.fillRect(Math.round(p.x - camX), Math.round(p.y - camY), p.size, p.size);
  }
  sx.globalAlpha = 1;
}

function drawFloaters(){
  tx.textAlign = 'center';
  tx.textBaseline = 'middle';
  for (const f of Game.floaters){
    const a = clamp(f.life, 0, 1);
    tx.globalAlpha = a;
    tx.font = (f.big ? 'bold 11px ' : 'bold 8px ') + 'ui-monospace,Menlo,Consolas,monospace';
    tx.fillStyle = '#05040a';
    tx.fillText(f.text, f.x*TILE - camX + 0.7, f.y*TILE - camY + 0.7);
    tx.fillStyle = f.color;
    tx.fillText(f.text, f.x*TILE - camX, f.y*TILE - camY);
  }
  tx.globalAlpha = 1;
}

/* --- HUD ------------------------------------------------------------ */
function drawHUD(){
  const p = Game.player;

  sx.globalAlpha = 0.78;
  sx.fillStyle = '#0b0912';
  sx.fillRect(0,0,BASE_W,30);
  sx.globalAlpha = 1;
  sx.fillStyle = '#2b2340';
  sx.fillRect(0,30,BASE_W,1);

  // Vitality
  const bw = 108;
  sx.fillStyle = '#1a0b12'; sx.fillRect(6,6,bw,8);
  const pct = clamp(p.hp / p.maxHp, 0, 1);
  sx.fillStyle = pct > 0.35 ? '#a01130' : '#6b0a1e';
  sx.fillRect(6,6,Math.round(bw*pct),8);
  sx.fillStyle = pct > 0.35 ? '#e0455f' : '#c8203f';
  sx.fillRect(6,6,Math.round(bw*pct),2);
  sx.fillStyle = '#3a2a58';
  sx.fillRect(6,6,bw,1); sx.fillRect(6,13,bw,1);
  sx.fillRect(6,6,1,8);  sx.fillRect(6+bw-1,6,1,8);

  // Shard pip
  sx.drawImage(ATLAS.shard[0], 4, 14);

  // Flasks
  for (let i = 0; i < Math.min(p.flasks, 5); i++) sx.drawImage(ATLAS.flask[0], 60 + i*11, 14);

  drawPanel(sx, UI.mute, false);
  drawPanel(sx, UI.quit, false);
  sx.fillStyle = Audio.muted ? '#6b6480' : '#39ff88';
  sx.fillRect(UI.mute.x+5, UI.mute.y+8, 3, 4);
  sx.fillRect(UI.mute.x+8, UI.mute.y+6, 2, 8);
  if (Audio.muted){
    sx.fillStyle = '#e0455f';
    sx.fillRect(UI.mute.x+4, UI.mute.y+4, 12, 1);
    sx.fillRect(UI.mute.x+4, UI.mute.y+15, 12, 1);
  } else {
    sx.fillStyle = '#39ff88';
    sx.fillRect(UI.mute.x+12, UI.mute.y+8, 1, 4);
    sx.fillRect(UI.mute.x+14, UI.mute.y+6, 1, 8);
  }
  sx.fillStyle = '#e0b34a';
  sx.fillRect(UI.quit.x+5, UI.quit.y+5, 10, 10);
  sx.fillStyle = '#0b0912';
  sx.fillRect(UI.quit.x+7, UI.quit.y+7, 6, 6);

  // Text layer
  tx.textAlign = 'left'; tx.textBaseline = 'alphabetic';
  tx.font = 'bold 7px ui-monospace,Menlo,Consolas,monospace';
  tx.fillStyle = '#d9d2b8';
  tx.fillText(p.hp + ' / ' + p.maxHp, 10, 13);
  tx.fillStyle = '#39ff88';
  tx.fillText(String(Game.shards), 18, 24);
  tx.fillStyle = '#8f8768';
  tx.fillText('x' + p.flasks, 60 + Math.min(p.flasks,5)*11, 24);

  tx.textAlign = 'right';
  tx.fillStyle = Game.map.isBoss ? '#e0b34a' : '#7a52c0';
  tx.font = 'bold 9px "Iowan Old Style",Georgia,serif';
  tx.fillText('DEPTH ' + roman(Game.depth), BASE_W - 54, 13);
  tx.font = '7px ui-monospace,Menlo,monospace';
  tx.fillStyle = '#6b6480';
  tx.fillText(Game.kills + ' slain · turn ' + Game.turn, BASE_W - 54, 24);

  // Message log, immediately under the HUD.
  tx.textAlign = 'left';
  tx.font = '7px ui-monospace,Menlo,monospace';
  for (let i = 0; i < Game.log.length; i++){
    tx.globalAlpha = 0.35 + 0.25 * i;
    tx.fillStyle = '#a89c78';
    tx.fillText(Game.log[i], 6, 42 + i * 9);
  }
  tx.globalAlpha = 1;
}

function drawControls(){
  const p = Game.player;
  drawPanel(sx, UI.up,    !!held.up);
  drawPanel(sx, UI.left,  !!held.left);
  drawPanel(sx, UI.right, !!held.right);
  drawPanel(sx, UI.down,  !!held.down);
  drawPanel(sx, UI.wait,  !!held.wait);
  drawArrow(sx, UI.up,    0,-1,'#d9d2b8');
  drawArrow(sx, UI.down,  0, 1,'#d9d2b8');
  drawArrow(sx, UI.left, -1, 0,'#d9d2b8');
  drawArrow(sx, UI.right, 1, 0,'#d9d2b8');
  sx.fillStyle = '#8f8768';
  sx.fillRect(UI.wait.x + 12, UI.wait.y + 12, 4, 4);

  const dashReady = Game.stats.hasDash && p.dashCd === 0;
  drawPanel(sx, UI.dash, !!held.dash, '#4a2c7a');
  if (!Game.stats.hasDash){
    sx.globalAlpha = 0.35; sx.fillStyle = '#0b0912';
    sx.fillRect(UI.dash.x+1, UI.dash.y+1, UI.dash.w-2, UI.dash.h-2);
    sx.globalAlpha = 1;
  } else if (!dashReady){
    const frac = p.dashCd / Math.max(1, Game.stats.dashCdMax);
    sx.globalAlpha = 0.6; sx.fillStyle = '#0b0912';
    sx.fillRect(UI.dash.x+1, UI.dash.y+1, UI.dash.w-2, Math.round((UI.dash.h-2)*frac));
    sx.globalAlpha = 1;
  }
  const flaskReady = p.flasks > 0;
  drawPanel(sx, UI.flask, !!held.flask, '#a01130');
  if (!flaskReady){
    sx.globalAlpha = 0.5; sx.fillStyle = '#0b0912';
    sx.fillRect(UI.flask.x+1, UI.flask.y+1, UI.flask.w-2, UI.flask.h-2);
    sx.globalAlpha = 1;
  }

  tx.textAlign = 'center'; tx.textBaseline = 'middle';
  tx.font = 'bold 8px ui-monospace,Menlo,monospace';
  tx.fillStyle = dashReady ? '#8dffc0' : '#6b6480';
  tx.fillText(Game.stats.hasDash && p.dashCd > 0 ? String(p.dashCd) : 'DASH',
              UI.dash.x + UI.dash.w/2, UI.dash.y + UI.dash.h/2);
  tx.fillStyle = flaskReady ? '#e0455f' : '#6b6480';
  tx.fillText('HEAL', UI.flask.x + UI.flask.w/2, UI.flask.y + UI.flask.h/2);
  tx.textBaseline = 'alphabetic';
}

/* --- Screens -------------------------------------------------------- */
function wrapText(ctx, text, maxWidth){
  const lines = [];
  let line = '';
  for (const ch of text){
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line){ lines.push(line); line = ch; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function drawTitle(){
  // Backdrop: a slow violet gradient with drifting motes of shard-light.
  const g = sx.createLinearGradient(0,0,0,BASE_H);
  g.addColorStop(0,'#150f26'); g.addColorStop(0.55,'#0b0912'); g.addColorStop(1,'#05040a');
  sx.fillStyle = g; sx.fillRect(0,0,BASE_W,BASE_H);
  for (let i = 0; i < 40; i++){
    const t = Game.time * 0.25 + i;
    const x = (i * 61 + Math.sin(t) * 22) % BASE_W;
    const y = (i * 97 + Game.time * 12) % BASE_H;
    sx.globalAlpha = 0.10 + 0.28 * ((Math.sin(t*2)+1)/2);
    sx.fillStyle = i % 4 === 0 ? '#39ff88' : '#7a52c0';
    sx.fillRect(x|0, y|0, 1, 1);
  }
  sx.globalAlpha = 1;

  sx.drawImage(ATLAS.ent.boss[((Game.time*1.6)|0) % 2], BASE_W/2 - 16, 92);
  sx.drawImage(ATLAS.ent.player[((Game.time*2.2)|0) % 2], BASE_W/2 - 8, 160);
  punchTitleVignette();

  drawPanel(sx, OVL.primary, true, '#4a2c7a');

  tx.textAlign = 'center'; tx.textBaseline = 'alphabetic';
  tx.fillStyle = '#d9d2b8';
  tx.font = 'bold 30px "Iowan Old Style","Palatino Linotype",Georgia,serif';
  tx.fillText('GLOOMFALL', BASE_W/2, 58);
  tx.fillStyle = '#a01130';
  tx.fillRect(BASE_W/2 - 52, 66, 104, 1);
  tx.font = 'italic 9px "Iowan Old Style",Georgia,serif';
  tx.fillStyle = '#8f8768';
  tx.fillText('Everything you carry out, you keep.', BASE_W/2, 80);

  tx.font = '8px ui-monospace,Menlo,monospace';
  tx.fillStyle = '#6b6480';
  tx.fillText('Deepest descent  ' + roman(Math.max(1, CFG.meta.bestDepth)), BASE_W/2, 210);
  tx.fillText(CFG.meta.shards + ' shards banked  ·  ' + CFG.meta.runs + ' descents', BASE_W/2, 224);

  tx.fillStyle = '#8f8768';
  tx.font = '7px ui-monospace,Menlo,monospace';
  tx.fillText('Arrows or WASD to move  ·  bump to strike', BASE_W/2, 250);
  tx.fillText('Q dash  ·  E flask  ·  Space wait  ·  M mute', BASE_W/2, 262);
  tx.fillText('On touch: the pad below, or swipe the floor', BASE_W/2, 274);
  tx.fillStyle = '#6b6480';
  tx.fillText('The gold seal, top right, ends a run and banks it', BASE_W/2, 286);

  tx.fillStyle = '#8dffc0';
  tx.font = 'bold 12px ui-monospace,Menlo,monospace';
  tx.fillText('DESCEND', BASE_W/2, OVL.primary.y + 22);

  tx.fillStyle = '#4c4560';
  tx.font = '7px ui-monospace,Menlo,monospace';
  tx.fillText('Spend shards in the Sanctum — open the sidebar', BASE_W/2, 400);
}

function punchTitleVignette(){
  const lg = light.x;
  lg.setTransform(1,0,0,1,0,0);
  lg.globalCompositeOperation = 'source-over';
  lg.fillStyle = '#000'; lg.fillRect(0,0,LW,LH);
  lg.globalCompositeOperation = 'destination-out';
  punch(lg, LW/2, 78, 62 + Math.sin(Game.time*1.4)*4, 0.96);
  sx.imageSmoothingEnabled = true;
  sx.globalAlpha = 0.55;
  sx.drawImage(light.c, 0, 0, BASE_W, BASE_H);
  sx.globalAlpha = 1;
  sx.imageSmoothingEnabled = false;
}

function drawDeath(){
  sx.globalAlpha = 0.90;
  sx.fillStyle = '#05040a';
  sx.fillRect(0,0,BASE_W,BASE_H);
  sx.globalAlpha = 1;
  sx.fillStyle = '#2b0a16';
  sx.fillRect(0, 78, BASE_W, 1);
  sx.fillRect(0, 236, BASE_W, 1);

  drawPanel(sx, OVL.primary, true, '#4a2c7a');
  drawPanel(sx, OVL.copy, false);

  tx.textAlign = 'center'; tx.textBaseline = 'alphabetic';
  tx.fillStyle = '#c8203f';
  tx.font = 'bold 22px "Iowan Old Style",Georgia,serif';
  tx.fillText('YOU HAVE FALLEN', BASE_W/2, 66);
  tx.fillStyle = '#8f8768';
  tx.font = 'italic 9px "Iowan Old Style",Georgia,serif';
  tx.fillText(Game.overReason, BASE_W/2, 98);

  tx.font = '9px ui-monospace,Menlo,monospace';
  const rows = [
    ['Depth reached', roman(Game.maxDepth)],
    ['Shards recovered', String(Game.shards)],
    ['Slain', String(Game.kills)],
    ['Turns endured', String(Game.turn)]
  ];
  rows.forEach((r,i) => {
    const y = 124 + i * 16;
    tx.textAlign = 'left';  tx.fillStyle = '#6b6480'; tx.fillText(r[0], 34, y);
    tx.textAlign = 'right'; tx.fillStyle = '#d9d2b8'; tx.fillText(r[1], BASE_W - 34, y);
  });

  tx.textAlign = 'center';
  tx.font = '7px ui-monospace,Menlo,monospace';
  if (Game.synced){
    tx.fillStyle = '#39ff88';
    tx.fillText('Seal sent to the Sanctum. Press "Bank this seal".', BASE_W/2, 204);
  } else {
    tx.fillStyle = Game.sealCopied ? '#39ff88' : '#e0b34a';
    tx.fillText(Game.sealCopied ? 'Seal copied. Paste it in the Sanctum.'
                                : 'Copy the seal into the Sanctum to keep these shards.',
                BASE_W/2, 204);
  }

  tx.font = '6px ui-monospace,Menlo,Consolas,monospace';
  tx.fillStyle = '#4c4560';
  const lines = wrapText(tx, Game.seal, BASE_W - 44);
  lines.slice(0,4).forEach((ln,i) => tx.fillText(ln, BASE_W/2, 220 + i*8));

  tx.fillStyle = '#8dffc0';
  tx.font = 'bold 12px ui-monospace,Menlo,monospace';
  tx.fillText('DESCEND AGAIN', BASE_W/2, OVL.primary.y + 22);
  tx.fillStyle = Game.sealCopied ? '#39ff88' : '#a89c78';
  tx.font = 'bold 9px ui-monospace,Menlo,monospace';
  tx.fillText(Game.sealCopied ? 'SEAL COPIED' : 'COPY SEAL', BASE_W/2, OVL.copy.y + 18);
}

/* =====================================================================
   14. INPUT
   Pointer and keyboard are peers. Every control has a keyboard route and
   a touch route, and nothing depends on hover (WCAG 2.2 pointer targets:
   all in-canvas buttons are >= 28 base px, which upscales well past the
   24x24 CSS minimum on any real viewport).
   ===================================================================== */
function toBase(ev){
  const r = scene.getBoundingClientRect();
  return {
    x: (ev.clientX - r.left) / r.width  * BASE_W,
    y: (ev.clientY - r.top)  / r.height * BASE_H
  };
}

let activePointer = null;
let swipeStart = null;
let repeatTimer = 0;
let heldDir = null;

function actFor(id){
  switch(id){
    case 'up':    lastDir = {x:0,y:-1}; tryMove(0,-1); break;
    case 'down':  lastDir = {x:0,y: 1}; tryMove(0, 1); break;
    case 'left':  lastDir = {x:-1,y:0}; tryMove(-1,0); break;
    case 'right': lastDir = {x: 1,y:0}; tryMove( 1,0); break;
    case 'wait':  wait(); break;
    case 'dash':  tryDash(); break;
    case 'flask': drinkFlask(); break;
  }
}

function onDown(ev){
  Audio.resume();
  stage.focus({ preventScroll: true });
  const b = toBase(ev);
  activePointer = ev.pointerId;

  if (Game.phase === 'title'){
    if (hit(OVL.primary, b.x, b.y) || b.y < 290) startRun();
    return;
  }
  if (Game.phase === 'dead'){
    if (hit(OVL.primary, b.x, b.y)) { startRun(); return; }
    if (hit(OVL.copy, b.x, b.y))    { copyText(Game.seal); trySyncToParent(Game.seal); return; }
    return;
  }

  if (hit(UI.mute, b.x, b.y)){ Audio.setMuted(!Audio.muted); return; }
  if (hit(UI.quit, b.x, b.y)){ endRun('you retreated into the light'); return; }

  for (const key of ['up','down','left','right','wait','dash','flask']){
    if (hit(UI[key], b.x, b.y)){
      held[key] = true;
      heldDir = key;
      repeatTimer = INPUT_REPEAT * 2.6;   // longer delay before the first repeat
      actFor(key);
      return;
    }
  }
  swipeStart = b;
}

function onMove(ev){
  if (activePointer !== ev.pointerId) return;
  if (!heldDir) return;
  const b = toBase(ev);
  if (!hit(UI[heldDir], b.x, b.y)){ held[heldDir] = false; heldDir = null; }
}

function onUp(ev){
  if (swipeStart && Game.phase === 'playing'){
    const b = toBase(ev);
    const dx = b.x - swipeStart.x, dy = b.y - swipeStart.y;
    if (Math.abs(dx) > 14 || Math.abs(dy) > 14){
      if (Math.abs(dx) > Math.abs(dy)) actFor(dx > 0 ? 'right' : 'left');
      else                             actFor(dy > 0 ? 'down'  : 'up');
    }
  }
  swipeStart = null;
  activePointer = null;
  if (heldDir){ held[heldDir] = false; heldDir = null; }
  for (const k in held) held[k] = false;
}

stage.addEventListener('pointerdown', function(e){ e.preventDefault(); onDown(e); }, {passive:false});
stage.addEventListener('pointermove', function(e){ e.preventDefault(); onMove(e); }, {passive:false});
stage.addEventListener('pointerup',   function(e){ e.preventDefault(); onUp(e);   }, {passive:false});
stage.addEventListener('pointercancel', function(){ swipeStart = null; heldDir = null; for (const k in held) held[k] = false; });
stage.addEventListener('contextmenu', function(e){ e.preventDefault(); });

const KEYMAP = {
  ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
  w:'up', s:'down', a:'left', d:'right',
  W:'up', S:'down', A:'left', D:'right'
};
window.addEventListener('keydown', function(e){
  Audio.resume();
  if (Game.phase === 'title'){
    if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); startRun(); }
    return;
  }
  if (Game.phase === 'dead'){
    if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); startRun(); }
    if (e.key === 'c' || e.key === 'C'){ copyText(Game.seal); trySyncToParent(Game.seal); }
    return;
  }
  const dir = KEYMAP[e.key];
  if (dir){
    e.preventDefault();
    held[dir] = true;
    actFor(dir);
    return;
  }
  switch(e.key){
    case ' ': e.preventDefault(); held.wait = true; wait(); break;
    case 'q': case 'Q': held.dash = true; tryDash(); break;
    case 'e': case 'E': held.flask = true; drinkFlask(); break;
    case 'm': case 'M': Audio.setMuted(!Audio.muted); break;
  }
});
window.addEventListener('keyup', function(e){
  const dir = KEYMAP[e.key];
  if (dir) held[dir] = false;
  if (e.key === ' ') held.wait = false;
  if (e.key === 'q' || e.key === 'Q') held.dash = false;
  if (e.key === 'e' || e.key === 'E') held.flask = false;
});

document.addEventListener('visibilitychange', function(){
  if (document.hidden && Audio.ctx) Audio.ctx.suspend().catch(()=>{});
  else if (Audio.started) Audio.resume();
});

/* =====================================================================
   15. MAIN LOOP
   ===================================================================== */
let last = performance.now();
function loop(now){
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;             // never let a stall become a teleport

  if (heldDir && Game.phase === 'playing'){
    repeatTimer -= dt * 1000;
    if (repeatTimer <= 0){ repeatTimer = INPUT_REPEAT; actFor(heldDir); }
  }

  updateEffects(dt);
  render(dt);
  requestAnimationFrame(loop);
}

/* =====================================================================
   16. BOOT
   ===================================================================== */
buildAtlas();
resize();
Audio.muted = !!CFG.muted;
Game.stats = derivedStats();

if (!load()){
  Game.phase = 'title';
  // Placeholder so the title screen can animate without a live run.
  Game.player = { x:0, y:0, rx:0, ry:0, hp:1, maxHp:1, flasks:0, dashCd:0,
                  revives:0, frame:0, atk:0, hurt:0, dir:1 };
}
stage.focus({ preventScroll: true });
requestAnimationFrame(loop);

})();
</script>
"""


def build_html() -> str:
    """Inject the Python-side configuration into the canvas document."""
    config = json.dumps(build_config(), separators=(",", ":"))
    # json.dumps cannot emit "</script>", but be explicit about the invariant.
    config = config.replace("</", "<\\/")
    return GAME_HTML.replace("__GLOOMFALL_CONFIG__", config)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    st.set_page_config(
        page_title=f"{APP_NAME} — a dark fantasy roguelike",
        page_icon="🕯",
        layout="centered",
        initial_sidebar_state="collapsed",
    )
    ensure_state()
    st.markdown(SHELL_CSS, unsafe_allow_html=True)
    render_sidebar()

    components.html(
        build_html(),
        height=st.session_state.viewport_h,
        scrolling=False,
    )

    st.caption(
        "Open the sidebar to reach the Sanctum, where shards become permanent rites. "
        "A run survives page refreshes and shopping trips; only death ends it."
    )


main()
