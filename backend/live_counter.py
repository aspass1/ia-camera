from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
import requests

try:
    from ultralytics import YOLO
except Exception:
    YOLO = None

ROOT = Path(__file__).resolve().parents[1]


def inside(point, zone, width, height):
    x, y = point
    x1, y1, x2, y2 = zone
    return x1 * width <= x <= x2 * width and y1 * height <= y <= y2 * height


def rectangle(zone, width, height):
    x1, y1, x2, y2 = zone
    return int(x1 * width), int(y1 * height), int(x2 * width), int(y2 * height)


@dataclass
class Track:
    id: int
    center: tuple[int, int]
    box: tuple[int, int, int, int]
    age: int = 0
    seen: int = 1
    triggered: bool = False
    counted: bool = False
    votes: list[str] = field(default_factory=list)


class CentroidTracker:
    def __init__(self, max_distance=150, max_age=45):
        self.max_distance, self.max_age, self.next_id = max_distance, max_age, 1
        self.tracks = {}

    def update(self, boxes):
        centers = [((x1 + x2) // 2, (y1 + y2) // 2) for x1, y1, x2, y2 in boxes]
        unmatched = set(range(len(boxes)))
        for track in list(self.tracks.values()):
            track.age += 1
            if not unmatched:
                continue
            index = min(unmatched, key=lambda i: math.dist(track.center, centers[i]))
            if math.dist(track.center, centers[index]) <= self.max_distance:
                track.center, track.box, track.age, track.seen = centers[index], boxes[index], 0, track.seen + 1
                unmatched.remove(index)
        for index in unmatched:
            self.tracks[self.next_id] = Track(self.next_id, centers[index], boxes[index])
            self.next_id += 1
        expired = [key for key, track in self.tracks.items() if track.age > self.max_age]
        for key in expired:
            del self.tracks[key]
        return list(self.tracks.values())


class Detector:
    def __init__(self, cfg):
        self.cfg = cfg
        self.model = None
        model_path = ROOT / cfg.get("model", "")
        if YOLO and model_path.is_file():
            self.model = YOLO(str(model_path))
        self.background = cv2.createBackgroundSubtractorMOG2(history=500, varThreshold=28, detectShadows=False)

    def boxes(self, frame):
        if self.model:
            result = self.model.predict(frame, conf=self.cfg.get("confidence", .35), verbose=False)[0]
            return [tuple(map(int, box.xyxy[0])) for box in result.boxes]
        mask = self.background.apply(frame)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((17, 17), np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        boxes = []
        for contour in contours:
            if cv2.contourArea(contour) < self.cfg.get("min_area", 3500):
                continue
            x, y, w, h = cv2.boundingRect(contour)
            boxes.append((x, y, x + w, y + h))
        return boxes


def post(url, path, payload):
    try:
        requests.post(url + path, json=payload, timeout=2).raise_for_status()
    except requests.RequestException:
        pass


def main():
    parser = argparse.ArgumentParser(description="LinhaCount - rastreamento por ID e destino")
    parser.add_argument("--machine", type=int, default=1)
    parser.add_argument("--source", default=None, help="Índice da câmera, URL ou vídeo")
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()
    config = json.loads((ROOT / "backend" / "config.json").read_text(encoding="utf-8"))
    cfg = config["machines"].get(str(args.machine))
    if not cfg:
        raise SystemExit(f"Máquina {args.machine} não configurada em backend/config.json")
    source = cfg["source"] if args.source is None else int(args.source) if args.source.isdigit() else args.source
    capture = cv2.VideoCapture(source, cv2.CAP_ANY)
    if not capture.isOpened():
        raise SystemExit("Não foi possível abrir a câmera/vídeo. Confira source em backend/config.json")
    detector, tracker = Detector(cfg), CentroidTracker()
    last_heartbeat = 0
    mode = "YOLO treinado" if detector.model else "movimento (modelo ainda ausente)"
    print(f"LinhaCount Máquina {args.machine}: {mode}. Pressione Q para sair.")
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        height, width = frame.shape[:2]
        tracks = tracker.update(detector.boxes(frame))
        for track in tracks:
            if track.age:
                continue
            if inside(track.center, cfg["trigger"], width, height):
                track.triggered = True
            if track.triggered and not track.counted and track.seen >= 3:
                destination = None
                if inside(track.center, cfg["good_zone"], width, height):
                    destination = "good"
                elif inside(track.center, cfg["residue_left"], width, height) or inside(track.center, cfg["residue_right"], width, height):
                    destination = "residue"
                if destination:
                    track.votes.append(destination)
                    if track.votes.count(destination) >= 3:
                        track.counted = True
                        post(config["server"], "/api/ai/event", {
                            "machine": args.machine, "kind": destination,
                            "track_id": str(track.id), "at": int(time.time() * 1000),
                        })
                        print(f"+1 {'PEÇA BOA' if destination == 'good' else 'RESÍDUO'} | ID {track.id}")
            color = (55, 210, 95) if track.counted else (0, 170, 255)
            x1, y1, x2, y2 = track.box
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            cv2.putText(frame, f"ID {track.id}", (x1, max(20, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, .55, color, 2)
        for name, color in [("trigger", (0, 220, 255)), ("good_zone", (30, 220, 80)), ("residue_left", (40, 60, 240)), ("residue_right", (40, 60, 240))]:
            x1, y1, x2, y2 = rectangle(cfg[name], width, height)
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            cv2.putText(frame, name, (x1 + 5, y1 + 20), cv2.FONT_HERSHEY_SIMPLEX, .5, color, 2)
        if time.time() - last_heartbeat > 2:
            post(config["server"], "/api/ai/heartbeat", {"machine": args.machine, "healthy": True})
            last_heartbeat = time.time()
        if not args.headless:
            cv2.imshow(f"LinhaCount - Maquina {args.machine}", frame)
            if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
                break
    capture.release()
    cv2.destroyAllWindows()
    post(config["server"], "/api/ai/heartbeat", {"machine": args.machine, "healthy": False})


if __name__ == "__main__":
    main()
