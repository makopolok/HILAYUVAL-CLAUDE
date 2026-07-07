FROM python:3.11-slim

WORKDIR /app

COPY download_bunny.py /app/download_bunny.py

RUN pip install --no-cache-dir requests tqdm

ENTRYPOINT ["python", "/app/download_bunny.py"]
