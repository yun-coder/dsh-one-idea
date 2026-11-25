#!/usr/bin/env python3
"""unisound_tts.py — 云知声 MaaS（U2-TTS）配音适配器。

给创意工作台的配音落地用：只做「一句话 → 一个 mp3」，接口和行为对齐
`skills/shared/scripts/tts.py speak` 的最小集（--text/--voice/--rate/-o），
所以 engine/voice.js 只要换一条命令行，合成、试听、时长门都不变。

云知声这套是**异步任务**：创建任务 → 轮询 → 按 file_id 下载，不是 OpenAI 的
`/audio/speech` 同步接口，所以 easel 的 voice_clone.py 那条 openai-compatible 路用不了。

用法：
    python unisound_tts.py --text "你好" -o out.mp3 \
        --voice-id cn_female_xiaodi_warm --speed 50 --key tp-xxx

    # 情绪（不是所有音色都支持，接口拒绝时自动去掉 emotion 重试一次）
    python unisound_tts.py --text "你好" -o out.mp3 --voice-id cn_male_chenyu --emotion happy --key tp-xxx
"""
from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_BASE_URL = "https://maas-api.hivoice.cn"
MODEL = "u2-tts"
SAMPLE_RATE = 32000
EMOTIONS = {"happy", "angry", "depressed", "whisper", "loudly", "neutral"}


class TTSError(Exception):
    pass


def request(url: str, *, method: str = "GET", body: bytes | None = None, key: str = "", timeout: int = 60) -> bytes:
    """带重试的 HTTP：本机到 maas-api.hivoice.cn 偶发 SSL EOF（约 1/3），重试 3 次。"""
    last: Exception | None = None
    for attempt in range(3):
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", f"Bearer {key}")
        if body is not None:
            req.add_header("Content-Type", "application/json;charset=UTF-8")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return response.read()
        except (urllib.error.URLError, ssl.SSLError, TimeoutError, ConnectionError) as error:
            last = error
            time.sleep(0.8 * (attempt + 1))
    raise TTSError(f"请求失败（{url}）：{last}")


def json_request(url: str, *, method: str = "GET", payload: dict | None = None, key: str = "") -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    raw = request(url, method=method, body=body, key=key)
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TTSError(f"接口返回不是 JSON：{error}；内容：{raw[:200]!r}") from error


def api_error(data: dict) -> str | None:
    base = data.get("base_resp") or {}
    code = base.get("status_code")
    if code in (None, 0, "0", "success"):
        return None
    return f"status_code={code}：{base.get('status_msg') or '未知错误'}"


def create_task(base: str, key: str, *, text: str, voice_id: str, speed: int, pitch: int, emotion: str | None) -> str:
    voice_setting = {
        "voice_id": voice_id,
        "speed": speed,
        "volume": 50,
        "pitch": max(0, min(100, int(pitch))),
        "bright": 50,
        "language": "zh",
    }
    if emotion:
        voice_setting["emotion"] = emotion
    payload = {
        "model": MODEL,
        "text": text,
        "voice_setting": voice_setting,
        "audio_setting": {"audio_sample_rate": SAMPLE_RATE, "format": "mp3", "channel": 1},
    }
    data = json_request(f"{base}/v1/audio/speech/tasks", method="POST", payload=payload, key=key)
    problem = api_error(data)
    if problem:
        raise TTSError(f"创建配音任务失败：{problem}；请求：{json.dumps(payload, ensure_ascii=False)[:400]}")
    task_id = str(data.get("task_id") or "")
    if not task_id:
        raise TTSError(f"创建任务没拿到 task_id：{json.dumps(data, ensure_ascii=False)[:300]}")
    return task_id


def wait_task(base: str, key: str, task_id: str, *, timeout: float, poll: float) -> dict:
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        url = f"{base}/v1/audio/speech/tasks?task_id={urllib.parse.quote(task_id)}"
        last = json_request(url, key=key)
        status = str(last.get("status") or "").lower()
        if status in {"success", "succeeded", "completed", "done", "finished"}:
            return last
        if status in {"failed", "error", "cancelled", "canceled"}:
            raise TTSError(f"配音任务失败：{json.dumps(last, ensure_ascii=False)[:400]}")
        time.sleep(poll)
    raise TTSError(f"配音任务超时（{timeout}s，task_id={task_id}，最后状态={last.get('status')}）")


def download(base: str, key: str, file_id: str, output: Path) -> int:
    url = f"{base}/v1/files/retrieve_content?file_id={urllib.parse.quote(str(file_id))}"
    content = request(url, key=key)
    if not content:
        raise TTSError("下载到的音频是空的")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(content)
    return len(content)


def synthesize(args) -> int:
    text = args.text.strip()
    if not text:
        raise TTSError("文本为空")
    key = (args.key or os.environ.get("UNISOUND_API_KEY", "")).strip()
    if not key:
        raise TTSError("没有 API key（--key 或环境变量 UNISOUND_API_KEY）")
    base = (args.base_url or DEFAULT_BASE_URL).rstrip("/")
    output = Path(args.output).expanduser().resolve()
    emotion = (args.emotion or "").strip().lower() or None
    if emotion and emotion not in EMOTIONS:
        emotion = None

    try:
        task_id = create_task(base, key, text=text, voice_id=args.voice_id, speed=args.speed, pitch=args.pitch, emotion=emotion)
    except TTSError as error:
        # 情绪不是每个音色都支持：去掉 emotion 再来一次，别因为一个 emotion 字段丢整句。
        if emotion and "emotion" in str(error):
            task_id = create_task(base, key, text=text, voice_id=args.voice_id, speed=args.speed, pitch=args.pitch, emotion=None)
        else:
            raise
    final = wait_task(base, key, task_id, timeout=args.timeout, poll=args.poll)
    file_id = final.get("file_id")
    if not file_id:
        raise TTSError(f"任务成功但没有 file_id：{json.dumps(final, ensure_ascii=False)[:300]}")
    size = download(base, key, str(file_id), output)
    print(json.dumps({"ok": True, "file": str(output), "bytes": size, "task_id": task_id, "voice_id": args.voice_id}, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="云知声 U2-TTS：一句话 → mp3（异步任务，内部轮询）")
    parser.add_argument("--text", required=True)
    parser.add_argument("-o", "--output", required=True)
    parser.add_argument("--voice-id", default="cn_male_chenyu")
    parser.add_argument("--speed", type=int, default=50, help="0–100，50 是原速")
    parser.add_argument("--pitch", type=int, default=50, help="0–100，50 是原调；长辈压低、少女抬高")
    parser.add_argument("--emotion", default=None, help="happy/angry/depressed/whisper/loudly/neutral")
    parser.add_argument("--key", default="", help="API key；留空读环境变量 UNISOUND_API_KEY")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--poll", type=float, default=1.2)
    args = parser.parse_args(argv)
    try:
        return synthesize(args)
    except TTSError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
