import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, Form
from fastapi.background import BackgroundTask
from fastapi.responses import FileResponse
import uvicorn


app = FastAPI(title="Chef Ibra Studio")


# ============================================================
# OUTILS
# ============================================================

def run_command(command):
    """
    Exécute une commande système et retourne :
    code retour + sortie standard + erreur.
    """
    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    stdout = result.stdout.decode(errors="ignore")
    stderr = result.stderr.decode(errors="ignore")

    return result.returncode, stdout, stderr


def get_audio_duration(audio_path):
    """
    Récupère la durée réelle de l'audio avec FFprobe.
    """
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
            f"Impossible de lire la durée audio: {stderr[-3000:]}"
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
    """
    Supprime le dossier temporaire après l'envoi du fichier.
    """
    try:
        shutil.rmtree(
            directory,
            ignore_errors=True,
        )
    except Exception:
        pass


def save_upload(upload_file, destination):
    """
    Sauvegarde un UploadFile sur le disque.
    """
    with open(destination, "wb") as output:
        shutil.copyfileobj(
            upload_file.file,
            output,
        )


# ============================================================
# PAGE DE SANTÉ
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
# INFORMATIONS DU STUDIO
# ============================================================

@app.get("/info")
def studio_info():
    return {
        "service": "Chef Ibra Studio",
        "version": "2.0",
        "engine": "FFmpeg",
        "input": {
            "images": "multiple",
            "audio": "one audio file",
        },
        "output": {
            "format": "MP4",
            "resolution": "1080x1920",
            "orientation": "vertical 9:16",
            "video_codec": "H.264",
            "audio_codec": "AAC",
        },
        "workflow": [
            "receive images",
            "receive audio",
            "create scenes",
            "assemble scenes",
            "add audio",
            "render final MP4",
            "return final video",
        ],
    }


# ============================================================
# RENDER VIDEO
# ============================================================

@app.post("/render")
async def render_video(
    audio: UploadFile = File(...),
    images: list[UploadFile] = File(...),
    duration: float = Form(0),
):
    """
    Moteur principal du Studio.

    Entrées :
        audio   = voix/audio principal
        images  = plusieurs images
        duration = durée totale optionnelle

    Si duration = 0 :
        la durée réelle de l'audio est utilisée.

    Sortie :
        chef-ibra-video.mp4
    """

    workdir = tempfile.mkdtemp(
        prefix="chef_ibra_"
    )

    try:

        # ----------------------------------------------------
        # 1. VÉRIFICATION DES IMAGES
        # ----------------------------------------------------

        if not images:
            return {
                "status": "error",
                "message": "Au moins une image est nécessaire.",
            }

        if len(images) > 100:
            return {
                "status": "error",
                "message": "Maximum 100 images par vidéo.",
            }

        # ----------------------------------------------------
        # 2. EXTENSIONS AUTORISÉES
        # ----------------------------------------------------

        allowed_extensions = {
            ".jpg",
            ".jpeg",
            ".png",
            ".webp",
            ".avif",
        }

        # ----------------------------------------------------
        # 3. SAUVEGARDE AUDIO
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
        # 4. DURÉE AUDIO
        # ----------------------------------------------------

        audio_duration = get_audio_duration(
            audio_path
        )

        # ----------------------------------------------------
        # 5. DURÉE FINALE
        # ----------------------------------------------------

        if duration is None:
            duration = 0

        duration = float(duration)

        if duration <= 0:
            duration = audio_duration

        if duration <= 0:
            return {
                "status": "error",
                "message": "La durée finale est invalide.",
            }

        # Ne jamais dépasser la durée audio.
        if duration > audio_duration:
            duration = audio_duration

        # ----------------------------------------------------
        # 6. SAUVEGARDE DES IMAGES
        # ----------------------------------------------------

        image_paths = []

        for index, image in enumerate(images):

            original_name = (
                image.filename
                or f"image_{index + 1}.jpg"
            )

            extension = (
                Path(original_name)
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
        # 7. CALCUL DE LA DURÉE DE CHAQUE SCÈNE
        # ----------------------------------------------------

        number_of_images = len(
            image_paths
        )

        scene_duration = (
            duration / number_of_images
        )

        if scene_duration < 0.5:
            return {
                "status": "error",
                "message": (
                    "Il y a trop d'images "
                    "pour la durée de la vidéo."
                ),
            }

        # ----------------------------------------------------
        # 8. CRÉATION DES INPUTS FFMPEG
        # ----------------------------------------------------

        command = [
            "ffmpeg",
            "-y",
        ]

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

        # Audio
        command.extend(
            [
                "-i",
                audio_path,
            ]
        )

        # ----------------------------------------------------
        # 9. CONSTRUCTION DU FILTER COMPLEX
        # ----------------------------------------------------

        filters = []

        for index in range(
            number_of_images
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
        # 10. CONCATÉNATION DES SCÈNES
        # ----------------------------------------------------

        concat_inputs = ""

        for index in range(
            number_of_images
        ):
            concat_inputs += (
                f"[scene{index}]"
            )

        concat_filter = (
            concat_inputs
            + f"concat=n={number_of_images}:"
              "v=1:a=0,"
              "format=yuv420p"
              "[video]"
        )

        filters.append(
            concat_filter
        )

        filter_complex = ";".join(
            filters
        )

        command.extend(
            [
                "-filter_complex",
                filter_complex,

                "-map",
                "[video]",

                "-map",
                f"{number_of_images}:a",

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
            ]
        )

        output_path = os.path.join(
            workdir,
            "chef-ibra-video.mp4",
        )

        command.append(
            output_path
        )

        # ----------------------------------------------------
        # 11. EXÉCUTION FFmpeg
        # ----------------------------------------------------

        code, stdout, stderr = run_command(
            command
        )

        # ----------------------------------------------------
        # 12. ERREUR FFmpeg
        # ----------------------------------------------------

        if code != 0:

            return {
                "status": "error",
                "message": "FFmpeg rendering failed.",
                "details": stderr[-8000:],
            }

        # ----------------------------------------------------
        # 13. VÉRIFICATION FICHIER
        # ----------------------------------------------------

        if not os.path.exists(
            output_path
        ):
            return {
                "status": "error",
                "message": (
                    "La vidéo finale "
                    "n'a pas été créée."
                ),
            }

        output_size = os.path.getsize(
            output_path
        )

        if output_size <= 0:
            return {
                "status": "error",
                "message": (
                    "La vidéo finale "
                    "est vide."
                ),
            }

        # ----------------------------------------------------
        # 14. RÉPONSE POUR PUBLISH
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

    except Exception as e:

        cleanup_directory(
            workdir
        )

        return {
            "status": "error",
            "message": (
                "Erreur pendant "
                "le rendu vidéo."
            ),
            "details": str(e),
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
