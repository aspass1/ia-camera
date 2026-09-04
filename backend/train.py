from pathlib import Path
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "dataset" / "data.yaml"
if not DATA.is_file():
    raise SystemExit("Falta dataset/data.yaml. Exporte as imagens marcadas no formato YOLO antes de treinar.")

model = YOLO("yolo11n.pt")
result = model.train(data=str(DATA), epochs=100, imgsz=640, batch=8, device=0, project=str(ROOT / "training-runs"), name="tecido")
best = Path(result.save_dir) / "weights" / "best.pt"
target = ROOT / "models" / "tecido-best.pt"
target.parent.mkdir(exist_ok=True)
target.write_bytes(best.read_bytes())
print(f"Modelo pronto: {target}")

