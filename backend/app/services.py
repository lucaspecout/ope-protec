from datetime import datetime, timedelta
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from sqlalchemy import delete
from sqlalchemy.orm import Session

from .config import settings
from .models import OperationalLog, WeatherAlert


def cleanup_old_weather_alerts(db: Session) -> int:
    cutoff = datetime.utcnow() - timedelta(days=settings.weather_retention_days)
    result = db.execute(delete(WeatherAlert).where(WeatherAlert.created_at < cutoff))
    db.commit()
    return result.rowcount or 0


def generate_pdf_report(db: Session, report_name: str = "rapport_veille.pdf") -> str:
    Path(settings.report_dir).mkdir(parents=True, exist_ok=True)
    report_path = str(Path(settings.report_dir) / report_name)
    c = canvas.Canvas(report_path, pagesize=A4)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(40, 800, "Protection Civile de l'Isère")
    c.drawString(40, 780, "Veille Opérationnelle – Isère")
    c.setFont("Helvetica", 10)
    y = 750
    c.drawString(40, y, f"Date: {datetime.utcnow().isoformat()}")
    y -= 30
    c.setFont("Helvetica-Bold", 12)
    c.drawString(40, y, "Chronologie main courante")
    y -= 20
    c.setFont("Helvetica", 10)
    logs = db.query(OperationalLog).order_by(OperationalLog.created_at.desc()).limit(15).all()
    for log in logs:
        c.drawString(45, y, f"- {log.created_at:%d/%m %H:%M} {log.event_type}: {log.description[:80]}")
        y -= 14
        if y < 80:
            c.showPage()
            y = 800
    c.drawString(40, 60, "Signature: ____________________")
    c.save()
    return report_path
