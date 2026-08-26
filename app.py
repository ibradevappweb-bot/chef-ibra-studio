import os
import shutil
import subprocess
import tempfile
from pathlib import Path

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
        if duration <= 0:
            return {
                "status": "error",
                "message": "Duration must be greater than 0",
            }

        # Nom original de l'image
        original_name = image.filename or "image.jpg"

        # Extension du fichier
        extension = Path(original_name).suffix.lower()

        # Extensions autorisées
        allowed_extensions = {
            ".jpg",
            ".jpeg",
            ".png",
            ".webp",
            ".avif",
        }

        if extension not in allowed_extensions:
            extension = ".jpg"

        # Chemins temporaires
        image_path = os.path.join(
            workdir,
            "input_image" + extension,
        )

        audio_path = os.path.join(
            workdir,
            "input_audio.mp3",
        )

        output_path = os.path.join(
            workdir,
            "chef-ibra-video.mp4",
        )

        # Sauvegarde de l'image
        with open(image_path, "wb") as image_file:
            shutil.copyfileobj(
                image.file,
                image_file,
            )

        # Sauvegarde de l'audio
        with open(audio_path, "wb") as audio_file:
            shutil.copyfileobj(
                audio.file,
                audio_file,
            )

        # Commande FFmpeg
        #
        # IMPORTANT :
        # Nous n'utilisons plus -loop.
        #
        # L'image est transformée en une image vidéo
        # puis tpad maintient la dernière image
        # pendant toute la durée demandée.

        video_filter = (
            "scale=1080:1920:"
            "force_original_aspect_ratio=decrease,"
            "pad=1080:1920:"
            "(ow-iw)/2:"
            "(oh-ih)/2,"
            "format=yuv420p,"
            f"tpad=stop_mode=clone:stop_duration={duration}"
        )

        command = [
            "ffmpeg",
            "-y",

            "-i",
            image_path,

            "-i",
            audio_path,

            "-filter_complex",
            f"[0:v]{video_filter}[video]",

            "-map",
            "[video]",

            "-map",
            "1:a",

            "-t",
            str(duration),

            "-r",
            "30",

            "-c:v",
            "libx264",

            "-preset",
            "veryfast",

            "-pix_fmt",
            "yuv420p",

            "-c:a",
            "aac",

            "-b:a",
            "128k",

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

        # Récupération des logs FFmpeg
        stderr = result.stderr.decode(
            errors="ignore"
        )

        # Vérification du résultat
        if result.returncode != 0:
            return {
                "status": "error",
                "message": "FFmpeg rendering failed",
                "details": stderr[-5000:],
            }

        # Vérification du fichier vidéo
        if not os.path.exists(output_path):
            return {
                "status": "error",
                "message": "Video file was not created",
            }

        # Vérification de la taille
        output_size = os.path.getsize(
            output_path
        )

        if output_size <= 0:
            return {
                "status": "error",
                "message": "Generated video file is empty",
            }

        # Retour de la vidéo
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

    finally:
        # Le fichier reste disponible pour FileResponse.
        # Le système temporaire de Render sera nettoyé
        # lorsque nécessaire.
        pass


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
