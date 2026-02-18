FROM denoland/deno:alpine-2.1.4

WORKDIR /app

COPY deno.json ./
COPY . .

# Clean old lock and regenerate with current dependencies
RUN rm -f deno.lock && deno cache main.ts

EXPOSE 8000

CMD ["deno", "run", "-A", "--unstable-cron", "main.ts"]
