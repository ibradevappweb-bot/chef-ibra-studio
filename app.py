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
        "engine": "FFmpeg",
    }


@app.post("/render")
async def render_video(
    audio: UploadFile = File(...),
    image: UploadFile = File(...),
    duration: int = Form(60),
):
    workdir = tempfile.mkdtemp()

    try:
        # Vérification de la durée
        if duration < 1:
            return {
                "status": "error",
                "message": "Duration must be at least 1 second",
            }

        if duration > 600:
            return {
                "status": "error",
                "message": "Duration cannot exceed 600 seconds",
            }

        # Récupération des extensions
        image_extension = os.path.splitext(image.filename or "")[1].lower()
        audio_extension = os.path.splitext(audio.filename or "")[1].lower()

        # Extensions par défaut
        if not image_extension:
            image_extension = ".img"

        if not audio_extension:
            audio_extension = ".audio"

        image_path = os.path.join(
            workdir,
            "input_image" + image_extension,
        )

        audio_path = os.path.join(
            workdir,
            "input_audio" + audio_extension,
        )

        output_path = os.path.join(
            workdir,
            "chef-ibra-video.mp4",
        )

        # Sauvegarde de l'image
        with open(image_path, "wb") as f:
            shutil.copyfileobj(image.file, f)

        # Sauvegarde de l'audio
        with open(audio_path, "wb") as f:
            shutil.copyfileobj(audio.file, f)

        # Commande FFmpeg
        command = [
            "ffmpeg",
            "-y",

            # Image répétée pendant toute la durée
            "-loop",
            "1",
            "-i",
            image_path,

            # Audio
            "-i",
            audio_path,

            # Durée maximale de la vidéo
            "-t",
            str(duration),

            # Format vertical 1080x1920
            "-vf",
            (
                "scale=1080:1920:"
                "force_original_aspect_ratio=decrease,"
                "pad=1080:1920:"
                "(ow-iw)/2:"
                "(oh-ih)/2,"
                "format=yuv420p"
            ),

            # Encodage vidéo
            "-c:v",
            "libx264",

            # Rapidité du rendu
            "-preset",
            "veryfast",

            # Format compatible
            "-pix_fmt",
            "yuv420p",

            # Encodage audio
            "-c:a",
            "aac",

            "-b:a",
            "128k",

            # Coupe quand l'audio se termine
            "-shortest",

            output_path,
        ]

        # Exécution FFmpeg
        result = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        # Vérification du résultat
        if result.returncode != 0:
            error_details = result.stderr.decode(
                errors="ignore"
            )

            return {
                "status": "error",
                "message": "FFmpeg rendering failed",
                "details": error_details[-4000:],
            }

        # Vérification que la vidéo existe
        if not os.path.exists(output_path):
            return {
                "status": "error",
                "message": "Video file was not created",
            }

        # Vérification de la taille
        output_size = os.path.getsize(output_path)

        if output_size == 0:
            return {
                "status": "error",
                "message": "Generated video is empty",
            }

        # Retourne la vidéo MP4
        return FileResponse(
            output_path,
            media_type="video/mp4",
            filename="chef-ibra-video.mp4",
        )

    except Exception as e:
        return {
            "status": "error",
            "message": "Unexpected rendering error",
            "details": str(e),
        }


if __name__ == "__main__":
    port = int(
        os.environ.get(
            "PORT",
            10000,
        )
    )

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        )
