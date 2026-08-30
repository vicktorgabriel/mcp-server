#!/usr/bin/env python3
"""Minimal X11 desktop input helper for the MCP full-control tools.

Uses python-xlib/XTEST so the MCP does not depend on xdotool. It intentionally
runs as the current desktop user and therefore cannot bypass OS permissions.
"""

import argparse
import json
import os
import sys
import time

try:
    from Xlib import X, XK, display
    from Xlib.ext import xtest
except Exception as exc:  # pragma: no cover - environment dependent
    print(json.dumps({"ok": False, "error": f"python-xlib unavailable: {exc}"}))
    sys.exit(2)


def open_display():
    name = os.environ.get("DISPLAY") or ":0"
    return display.Display(name)


def keycode_and_modifiers(dpy, token):
    aliases = {
        "ctrl": "Control_L", "control": "Control_L",
        "alt": "Alt_L", "meta": "Meta_L", "super": "Super_L", "win": "Super_L",
        "shift": "Shift_L", "enter": "Return", "return": "Return",
        "esc": "Escape", "escape": "Escape", "tab": "Tab", "space": "space",
        "backspace": "BackSpace", "delete": "Delete", "del": "Delete",
        "home": "Home", "end": "End", "pageup": "Page_Up", "pagedown": "Page_Down",
        "up": "Up", "down": "Down", "left": "Left", "right": "Right",
    }
    name = aliases.get(token.lower(), token)
    keysym = XK.string_to_keysym(name)
    if not keysym and len(token) == 1:
        keysym = ord(token)
    if not keysym:
        raise ValueError(f"Unknown key: {token}")

    min_code = dpy.display.info.min_keycode
    max_code = dpy.display.info.max_keycode
    for code in range(min_code, max_code + 1):
        for index in range(4):
            if dpy.keycode_to_keysym(code, index) == keysym:
                mods = []
                if index in (1, 3):
                    mods.append("Shift_L")
                if index in (2, 3):
                    mods.append("ISO_Level3_Shift")
                return code, mods

    code = dpy.keysym_to_keycode(keysym)
    if code:
        return code, []
    raise ValueError(f"No keycode for: {token}")


def emit_key(dpy, token, press=True):
    code, implicit_mods = keycode_and_modifiers(dpy, token)
    for mod in implicit_mods:
        mod_code, _ = keycode_and_modifiers(dpy, mod)
        xtest.fake_input(dpy, X.KeyPress, mod_code)
    xtest.fake_input(dpy, X.KeyPress if press else X.KeyRelease, code)
    if not press:
        for mod in reversed(implicit_mods):
            mod_code, _ = keycode_and_modifiers(dpy, mod)
            xtest.fake_input(dpy, X.KeyRelease, mod_code)


def cmd_mouse_move(args):
    dpy = open_display()
    root = dpy.screen().root
    root.warp_pointer(int(args.x), int(args.y))
    dpy.sync()
    return {"ok": True, "x": int(args.x), "y": int(args.y)}


def cmd_mouse_click(args):
    dpy = open_display()
    button = int(args.button)
    count = max(1, int(args.count))
    delay = max(0.0, float(args.interval_ms) / 1000.0)
    for idx in range(count):
        xtest.fake_input(dpy, X.ButtonPress, button)
        xtest.fake_input(dpy, X.ButtonRelease, button)
        dpy.sync()
        if idx + 1 < count and delay:
            time.sleep(delay)
    return {"ok": True, "button": button, "count": count}


def cmd_mouse_scroll(args):
    dpy = open_display()
    amount = int(args.amount)
    button = 4 if amount > 0 else 5
    for _ in range(abs(amount)):
        xtest.fake_input(dpy, X.ButtonPress, button)
        xtest.fake_input(dpy, X.ButtonRelease, button)
    dpy.sync()
    return {"ok": True, "amount": amount}


def cmd_hotkey(args):
    dpy = open_display()
    keys = [part.strip() for part in args.keys.split("+") if part.strip()]
    if not keys:
        raise ValueError("No keys supplied")
    pressed = []
    for key in keys:
        code, implicit = keycode_and_modifiers(dpy, key)
        for mod in implicit:
            mod_code, _ = keycode_and_modifiers(dpy, mod)
            xtest.fake_input(dpy, X.KeyPress, mod_code)
            pressed.append((mod_code, mod))
        xtest.fake_input(dpy, X.KeyPress, code)
        pressed.append((code, key))
    dpy.sync()
    for code, _ in reversed(pressed):
        xtest.fake_input(dpy, X.KeyRelease, code)
    dpy.sync()
    return {"ok": True, "keys": keys}


def cmd_type_text(args):
    dpy = open_display()
    delay = max(0.0, float(args.interval_ms) / 1000.0)
    typed = 0
    skipped = []
    for char in args.text:
        token = "Return" if char == "\n" else "Tab" if char == "\t" else char
        try:
            code, implicit = keycode_and_modifiers(dpy, token)
            mod_codes = []
            for mod in implicit:
                mod_code, _ = keycode_and_modifiers(dpy, mod)
                xtest.fake_input(dpy, X.KeyPress, mod_code)
                mod_codes.append(mod_code)
            xtest.fake_input(dpy, X.KeyPress, code)
            xtest.fake_input(dpy, X.KeyRelease, code)
            for mod_code in reversed(mod_codes):
                xtest.fake_input(dpy, X.KeyRelease, mod_code)
            dpy.sync()
            typed += 1
            if delay:
                time.sleep(delay)
        except Exception:
            skipped.append(char)
    return {"ok": not skipped, "typed": typed, "skipped": skipped}


def build_parser():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("mouse-move")
    p.add_argument("x", type=int)
    p.add_argument("y", type=int)
    p.set_defaults(func=cmd_mouse_move)

    p = sub.add_parser("mouse-click")
    p.add_argument("--button", type=int, default=1)
    p.add_argument("--count", type=int, default=1)
    p.add_argument("--interval-ms", type=int, default=80)
    p.set_defaults(func=cmd_mouse_click)

    p = sub.add_parser("mouse-scroll")
    p.add_argument("amount", type=int)
    p.set_defaults(func=cmd_mouse_scroll)

    p = sub.add_parser("hotkey")
    p.add_argument("keys")
    p.set_defaults(func=cmd_hotkey)

    p = sub.add_parser("type-text")
    p.add_argument("text")
    p.add_argument("--interval-ms", type=int, default=10)
    p.set_defaults(func=cmd_type_text)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    try:
        result = args.func(args)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
