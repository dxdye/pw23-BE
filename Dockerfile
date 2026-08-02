FROM denoland/deno:alpine-2.5.6

WORKDIR /app

# Abhängigkeiten in einer eigenen Schicht: ändert sich nur der Quellcode,
# bleibt diese Schicht im Cache.
COPY deno.json deno.lock ./
COPY src/ ./src/
RUN deno cache --frozen src/main.ts

# Der Cache liegt als SQLite-Datei hier. Als Volume einhängen, damit ein
# Neustart nicht mit leerem Cache gegen das GitHub-Rate-Limit läuft.
RUN mkdir -p /app/data && chown -R deno:deno /app/data
VOLUME ["/app/data"]

USER deno

EXPOSE 8000

# `deno eval` läuft mit vollen Rechten und lehnt Permission-Flags ab.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["deno", "eval", "Deno.exit((await fetch('http://localhost:8000/')).ok ? 0 : 1)"]

# Statt `-A` nur, was der Dienst braucht: Netz, Umgebung, Lesen des Quellcodes
# und Schreiben ausschließlich im Datenverzeichnis.
CMD ["deno", "run", \
  "--allow-net", \
  "--allow-env", \
  "--allow-read=/app", \
  "--allow-write=/app/data", \
  "src/main.ts"]
