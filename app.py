import os
import shutil
import subprocess
import tempfile
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.responses import FileResponse
import uvicorn

app = FastAPI(title="Chef Ibra Studio")

@app.get("/")
def health():
    return {
        "status": "online",
        "service": "Chef Ibra Studio",
        "engine": "FFmpeg"
    }

@app.post("/render")
async def render_video(
    audio: UploadFile = File(...),
    image: UploadFile = File(...),
    duration: int = Form(60)
):
    workdir = tempfile.mkdtemp()

    try:
        image_path = os.path.join(workdir, "image.jpg")
        audio_path = os.path.join(workdir, "audio.mp3")
        output_path = os.path.join(workdir, "video.mp4")

        with open(image_path, "wb") as f:
            shutil.copyfileobj(image.file, f)

        with open(audio_path, "wb") as f:
            shutil.copyfileobj(audio.file, f)

        command = [
            "ffmpeg",
            "-y",
            "-loop", "1",
            "-i", image_path,
            "-i", audio_path,
            "-t", str(duration),
            "-vf",
            "scale=1080:1920:force_original_aspect_ratio=decrease,"
            "pad=1080:1920:(ow-iw)/2:(oh-ih)/2",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "128k",
            "-shortest",
            output_path
        ]

        subprocess.run(
            command,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )

        return FileResponse(
            output_path,
            media_type="video/mp4",
            filename="chef-ibra-video.mp4"
        )

    except subprocess.CalledProcessError as e:
        return {
            "status": "error",
            "message": "FFmpeg rendering failed",
            "details": e.stderr.decode(errors="ignore")[-2000:]
        }

    finally:
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    uvicorn.run(app, host="0.0.0.0", port=port)
