import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
import uvicorn


app = FastAPI(title="Chef Ibra Studio")


# ============================================================
# OUTILS
# ============================================================

def run_command(command):
    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    stdout = result.stdout.decode(errors="ignore")
    stderr = result.stderr.decode(errors="ignore")

    return result.returncode, stdout, stderr


def save_upload(upload_file, destination):
    with open(destination, "wb") as output_file:
        shutil.copyfileobj(
            upload_file.file,
            output_file,
        )


def get_audio_duration(audio_path):
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        audio_path,
    ]

    code, stdout, stderr = run_command(command)

    if code != 0:
        raise RuntimeError(
            f"Impossible de lire la durée audio : {stderr[-3000:]}"
        )

    data = json.loads(stdout)

    duration = float(
        data["format"]["duration"]
    )

    if duration <= 0:
        raise RuntimeError(
            "La durée de l'audio est invalide."
        )

    return duration


def cleanup_directory(directory):
    shutil.rmtree(
        directory,
        ignore_errors=True,
    )


# ============================================================
# TEST DU SERVEUR
# ============================================================

@app.get("/")
def health():
    return {
        "status": "online",
        "service": "Chef Ibra Studio",
        "engine": "FFmpeg",
        "version": "2.0",
        "message": "Video rendering engine ready",
    }


# ============================================================
# INFORMATIONS
# ============================================================

@app.get("/info")
def info():
    return {
        "service": "Chef Ibra Studio",
        "engine": "FFmpeg",
        "input": {
            "images": "multiple",
            "audio": "one file",
        },
        "output": {
            "format": "MP4",
            "resolution": "1080x1920",
            "orientation": "9:16",
            "video_codec": "H.264",
            "audio_codec": "AAC",
        },
    }


# ============================================================
# MOTEUR DE RENDU
# ============================================================

@app.post("/render")
async def render_video(
    audio: UploadFile = File(...),
    images: list[UploadFile] = File(...),
    duration: float = Form(0),
):
    workdir = tempfile.mkdtemp(
        prefix="chef_ibra_"
    )

    try:

        # ----------------------------------------------------
        # VÉRIFICATION DES IMAGES
        # ----------------------------------------------------

        if not images:
            return {
                "status": "error",
                "message": "Au moins une image est nécessaire.",
            }

        if len(images) > 100:
            return {
                "status": "error",
                "message": "Maximum 100 images.",
            }

        allowed_extensions = {
            ".jpg",
            ".jpeg",
            ".png",
            ".webp",
            ".avif",
        }

        # ----------------------------------------------------
        # SAUVEGARDE AUDIO
        # ----------------------------------------------------

        audio_name = (
            audio.filename
            or "audio.mp3"
        )

        audio_extension = (
            Path(audio_name)
            .suffix
            .lower()
        )

        if not audio_extension:
            audio_extension = ".mp3"

        audio_path = os.path.join(
            workdir,
            "audio" + audio_extension,
        )

        save_upload(
            audio,
            audio_path,
        )

        # ----------------------------------------------------
        # DURÉE AUDIO
        # ----------------------------------------------------

        audio_duration = get_audio_duration(
            audio_path
        )

        # Si aucune durée n'est donnée,
        # utiliser automatiquement celle de l'audio.

        if duration <= 0:
            duration = audio_duration

        # Ne jamais dépasser l'audio.

        if duration > audio_duration:
            duration = audio_duration

        # ----------------------------------------------------
        # SAUVEGARDE DES IMAGES
        # ----------------------------------------------------

        image_paths = []

        for index, image in enumerate(images):

            filename = (
                image.filename
                or f"image_{index + 1}.jpg"
            )

            extension = (
                Path(filename)
                .suffix
                .lower()
            )

            if extension not in allowed_extensions:
                extension = ".jpg"

            image_path = os.path.join(
                workdir,
                f"image_{index + 1:03d}{extension}",
            )

            save_upload(
                image,
                image_path,
            )

            image_paths.append(
                image_path
            )

        # ----------------------------------------------------
        # DURÉE DE CHAQUE IMAGE
        # ----------------------------------------------------

        image_count = len(
            image_paths
        )

        scene_duration = (
            duration / image_count
        )

        if scene_duration < 0.5:
            return {
                "status": "error",
                "message": (
                    "La durée est trop courte "
                    "pour autant d'images."
                ),
            }

        # ----------------------------------------------------
        # CONSTRUCTION DE LA COMMANDE FFMPEG
        # ----------------------------------------------------

        command = [
            "ffmpeg",
            "-y",
        ]

        # Chaque image devient une petite séquence vidéo.

        for image_path in image_paths:
            command.extend(
                [
                    "-loop",
                    "1",
                    "-t",
                    f"{scene_duration:.3f}",
                    "-i",
                    image_path,
                ]
            )

        # Audio en dernier input.

        audio_input_index = image_count

        command.extend(
            [
                "-i",
                audio_path,
            ]
        )

        # ----------------------------------------------------
        # FILTRES VIDÉO
        # ----------------------------------------------------

        filters = []

        for index in range(
            image_count
        ):

            filters.append(
                (
                    f"[{index}:v]"
                    "scale=1080:1920:"
                    "force_original_aspect_ratio=increase,"
                    "crop=1080:1920,"
                    "setsar=1,"
                    "fps=30,"
                    "format=yuv420p"
                    f"[scene{index}]"
                )
            )

        # ----------------------------------------------------
        # CONCATÉNATION
        # ----------------------------------------------------

        concat_inputs = ""

        for index in range(
            image_count
        ):
            concat_inputs += (
                f"[scene{index}]"
            )

        filters.append(
            concat_inputs
            + f"concat=n={image_count}:"
              "v=1:a=0,"
              "format=yuv420p"
              "[video]"
        )

        filter_complex = ";".join(
            filters
        )

        # ----------------------------------------------------
        # FICHIER FINAL
        # ----------------------------------------------------

        output_path = os.path.join(
            workdir,
            "chef-ibra-video.mp4",
        )

        command.extend(
            [
                "-filter_complex",
                filter_complex,

                "-map",
                "[video]",

                "-map",
                f"{audio_input_index}:a",

                "-t",
                f"{duration:.3f}",

                "-r",
                "30",

                "-c:v",
                "libx264",

                "-preset",
                "veryfast",

                "-crf",
                "23",

                "-pix_fmt",
                "yuv420p",

                "-c:a",
                "aac",

                "-b:a",
                "192k",

                "-ar",
                "48000",

                "-ac",
                "2",

                "-movflags",
                "+faststart",

                output_path,
            ]
        )

        # ----------------------------------------------------
        # EXÉCUTION
        # ----------------------------------------------------

        code, stdout, stderr = run_command(
            command
        )

        # ----------------------------------------------------
        # ERREUR FFmpeg
        # ----------------------------------------------------

        if code != 0:
            cleanup_directory(
                workdir
            )

            return {
                "status": "error",
                "message": "FFmpeg rendering failed.",
                "details": stderr[-8000:],
            }

        # ----------------------------------------------------
        # VÉRIFICATION DU FICHIER
        # ----------------------------------------------------

        if not os.path.exists(
            output_path
        ):
            cleanup_directory(
                workdir
            )

            return {
                "status": "error",
                "message": (
                    "La vidéo finale "
                    "n'a pas été créée."
                ),
            }

        file_size = os.path.getsize(
            output_path
        )

        if file_size <= 0:
            cleanup_directory(
                workdir
            )

            return {
                "status": "error",
                "message": (
                    "La vidéo finale est vide."
                ),
            }

        # ----------------------------------------------------
        # RETOUR DE LA VRAIE VIDÉO
        # ----------------------------------------------------

        cleanup = BackgroundTask(
            cleanup_directory,
            workdir,
        )

        return FileResponse(
            output_path,
            media_type="video/mp4",
            filename="chef-ibra-video.mp4",
            background=cleanup,
        )

    except Exception as error:

        cleanup_directory(
            workdir
        )

        return {
            "status": "error",
            "message": "Erreur de rendu vidéo.",
            "details": str(error),
        }


# ============================================================
# DÉMARRAGE
# ============================================================

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
