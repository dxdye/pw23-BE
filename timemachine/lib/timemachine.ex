defmodule Timemachine do
  @moduledoc """
  Historisierung der GitHub-Aktivität für den Time-Machine-Slider.

  Reiner Schreibpfad: der Poller gleicht periodisch mit GitHub ab, die
  Historie liegt als Gültigkeitsintervalle in SQLite, und der Materialisierer
  schreibt sie als statische `timeline.json`, die nginx direkt ausliefert.
  Der Dienst liegt damit nicht im Request-Pfad des Sliders.
  """
end
