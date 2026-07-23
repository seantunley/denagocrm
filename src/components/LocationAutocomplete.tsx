"use client";

import { useEffect, useRef, useState } from "react";

type FormattableText = {
  toString(): string;
};

type GooglePlace = {
  displayName?: string;
  formattedAddress?: string;
  fetchFields(options: { fields: string[] }): Promise<void>;
};

type PlacePrediction = {
  text: FormattableText;
  mainText?: FormattableText;
  secondaryText?: FormattableText;
  toPlace(): GooglePlace;
};

type AutocompleteSuggestionItem = {
  placePrediction?: PlacePrediction;
};

type AutocompleteRequest = {
  input: string;
  sessionToken: unknown;
  includedRegionCodes: string[];
  language: string;
  region: string;
  locationBias: {
    center: { lat: number; lng: number };
    radius: number;
  };
};

type PlacesLibrary = {
  AutocompleteSessionToken: new () => unknown;
  AutocompleteSuggestion: {
    fetchAutocompleteSuggestions(
      request: AutocompleteRequest,
    ): Promise<{ suggestions: AutocompleteSuggestionItem[] }>;
  };
};

type GoogleMapsWindow = Window & {
  google?: { maps?: { importLibrary(name: string): Promise<unknown> } };
  __denagoGoogleMapsReady?: () => void;
  __denagoGoogleMapsAuthHooked?: boolean;
  gm_authFailure?: () => void;
};

type PlacesLoadResult = {
  library: PlacesLibrary | null;
  error: string | null;
};

const MAPS_ERROR_EVENT = "denago-google-maps-error";
const MAPS_SCRIPT_SELECTOR = 'script[data-denago-google-maps="true"]';
const MAPS_LOAD_TIMEOUT_MS = 15_000;
const AUTOCOMPLETE_DELAY_MS = 250;
const MIN_QUERY_LENGTH = 3;

let placesLibraryPromise: Promise<PlacesLoadResult> | null = null;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Google Maps could not be loaded.";
}

function reportMapsError(message: string): void {
  console.error(`[Google Maps autocomplete] ${message}`);
  window.dispatchEvent(new CustomEvent<string>(MAPS_ERROR_EVENT, { detail: message }));
}

function installAuthFailureHook(mapsWindow: GoogleMapsWindow): void {
  if (mapsWindow.__denagoGoogleMapsAuthHooked) return;

  const previous = mapsWindow.gm_authFailure;
  mapsWindow.gm_authFailure = () => {
    previous?.();
    reportMapsError(
      "Google rejected the browser key. Check the key's website referrers, API restrictions and billing project.",
    );
  };
  mapsWindow.__denagoGoogleMapsAuthHooked = true;
}

async function loadGoogleMapsScript(
  mapsWindow: GoogleMapsWindow,
  apiKey: string,
): Promise<void> {
  if (mapsWindow.google?.maps?.importLibrary) return;

  installAuthFailureHook(mapsWindow);

  await new Promise<void>((resolve, reject) => {
    document.querySelectorAll(MAPS_SCRIPT_SELECTOR).forEach((stale) => stale.remove());

    const script = document.createElement("script");
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      delete mapsWindow.__denagoGoogleMapsReady;
      script.onerror = null;

      if (error) {
        script.remove();
        reject(error);
      } else {
        resolve();
      }
    };

    const timeoutId = window.setTimeout(() => {
      finish(new Error("Google Maps took too long to load. Check browser blocking or network policy."));
    }, MAPS_LOAD_TIMEOUT_MS);

    mapsWindow.__denagoGoogleMapsReady = () => finish();
    script.dataset.denagoGoogleMaps = "true";
    script.async = true;
    script.onerror = () => {
      finish(new Error("The Google Maps JavaScript file was blocked or could not be downloaded."));
    };
    script.src =
      "https://maps.googleapis.com/maps/api/js?" +
      new URLSearchParams({
        key: apiKey,
        loading: "async",
        libraries: "places",
        callback: "__denagoGoogleMapsReady",
        v: "weekly",
        language: "en",
        region: "ZA",
      });
    document.head.appendChild(script);
  });
}

async function getPlacesLibrary(): Promise<PlacesLoadResult> {
  if (placesLibraryPromise) return placesLibraryPromise;

  placesLibraryPromise = (async () => {
    try {
      const response = await fetch("/api/integrations/google-maps", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (response.status === 401) {
        throw new Error("Your CRM session expired before the Google Maps key could be loaded.");
      }
      if (!response.ok) {
        throw new Error(`The CRM Maps configuration endpoint returned HTTP ${response.status}.`);
      }

      const config = (await response.json()) as { apiKey?: string | null };
      if (!config.apiKey) {
        throw new Error("No Google Maps browser key is available to this CRM workspace.");
      }

      const mapsWindow = window as GoogleMapsWindow;
      installAuthFailureHook(mapsWindow);
      await loadGoogleMapsScript(mapsWindow, config.apiKey);

      const imported = await mapsWindow.google?.maps?.importLibrary("places");
      const library = imported as Partial<PlacesLibrary> | undefined;
      if (
        !library ||
        typeof library.AutocompleteSessionToken !== "function" ||
        typeof library.AutocompleteSuggestion?.fetchAutocompleteSuggestions !== "function"
      ) {
        throw new Error(
          "Google loaded without Autocomplete Data. Enable Maps JavaScript API and Places API (New) on this key's project.",
        );
      }

      return { library: library as PlacesLibrary, error: null };
    } catch (error) {
      const message = errorMessage(error);
      reportMapsError(message);
      return { library: null, error: message };
    }
  })();

  const result = await placesLibraryPromise;
  if (!result.library) placesLibraryPromise = null;
  return result;
}

function predictionLabel(prediction: PlacePrediction): string {
  return prediction.text.toString();
}

export default function LocationAutocomplete({
  name = "location",
  value,
  defaultValue = "",
  onValueChange,
  className = "input",
  placeholder = "Start typing an address or place",
  required = false,
}: {
  name?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  placeholder?: string;
  required?: boolean;
}) {
  const [mode, setMode] = useState<"loading" | "ready" | "fallback">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [currentValue, setCurrentValue] = useState(value ?? defaultValue);
  const [predictions, setPredictions] = useState<PlacePrediction[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const libraryRef = useRef<PlacesLibrary | null>(null);
  const sessionTokenRef = useRef<unknown>(null);
  const searchTimerRef = useRef<number | null>(null);
  const requestSequenceRef = useRef(0);
  const latestValueRef = useRef(currentValue);
  const onValueChangeRef = useRef(onValueChange);

  useEffect(() => {
    onValueChangeRef.current = onValueChange;
  }, [onValueChange]);

  useEffect(() => {
    if (value === undefined) return;
    latestValueRef.current = value;
    setCurrentValue(value);
  }, [value]);

  useEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setPredictions([]);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, []);

  useEffect(() => {
    let disposed = false;

    const showFallback = (message: string) => {
      if (disposed) return;
      libraryRef.current = null;
      sessionTokenRef.current = null;
      setPredictions([]);
      setSearching(false);
      setLoadError(message);
      setMode("fallback");
    };

    const handleGlobalError = (event: Event) => {
      const message =
        event instanceof CustomEvent && typeof event.detail === "string"
          ? event.detail
          : "Google Maps rejected the autocomplete request.";
      showFallback(message);
    };

    window.addEventListener(MAPS_ERROR_EVENT, handleGlobalError);
    setMode("loading");
    setLoadError(null);

    void getPlacesLibrary().then(({ library, error }) => {
      if (disposed) return;
      if (!library) {
        showFallback(error ?? "Google Maps autocomplete is unavailable.");
        return;
      }
      libraryRef.current = library;
      setMode("ready");
    });

    return () => {
      disposed = true;
      window.removeEventListener(MAPS_ERROR_EVENT, handleGlobalError);
      if (searchTimerRef.current != null) window.clearTimeout(searchTimerRef.current);
      requestSequenceRef.current += 1;
    };
  }, [retryKey]);

  const updateValue = (next: string) => {
    latestValueRef.current = next;
    setCurrentValue(next);
    onValueChangeRef.current?.(next);
  };

  const queuePredictions = (next: string) => {
    if (searchTimerRef.current != null) window.clearTimeout(searchTimerRef.current);
    requestSequenceRef.current += 1;
    const requestId = requestSequenceRef.current;
    const query = next.trim();

    if (!libraryRef.current || query.length < MIN_QUERY_LENGTH) {
      if (!query) sessionTokenRef.current = null;
      setPredictions([]);
      setActiveIndex(-1);
      setSearching(false);
      return;
    }

    setSearching(true);
    searchTimerRef.current = window.setTimeout(() => {
      const library = libraryRef.current;
      if (!library) return;
      sessionTokenRef.current ??= new library.AutocompleteSessionToken();

      void library.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: query,
        sessionToken: sessionTokenRef.current,
        includedRegionCodes: ["za"],
        language: "en",
        region: "za",
        locationBias: {
          center: { lat: -33.925, lng: 18.48 },
          radius: 100_000,
        },
      })
        .then(({ suggestions }) => {
          if (requestId !== requestSequenceRef.current) return;
          setPredictions(
            suggestions.flatMap((suggestion) =>
              suggestion.placePrediction ? [suggestion.placePrediction] : [],
            ),
          );
          setActiveIndex(-1);
        })
        .catch((error) => {
          if (requestId !== requestSequenceRef.current) return;
          console.error("[Google Maps autocomplete] Suggestions failed", error);
          libraryRef.current = null;
          sessionTokenRef.current = null;
          setPredictions([]);
          setLoadError(
            "Google denied the Places request. Check the browser key's referrer and API restrictions in Google Cloud.",
          );
          setMode("fallback");
        })
        .finally(() => {
          if (requestId === requestSequenceRef.current) setSearching(false);
        });
    }, AUTOCOMPLETE_DELAY_MS);
  };

  const selectPrediction = async (prediction: PlacePrediction) => {
    requestSequenceRef.current += 1;
    if (searchTimerRef.current != null) window.clearTimeout(searchTimerRef.current);
    setPredictions([]);
    setActiveIndex(-1);
    setSearching(true);

    const fallbackLabel = predictionLabel(prediction);
    try {
      const place = prediction.toPlace();
      await place.fetchFields({ fields: ["displayName", "formattedAddress"] });
      updateValue(place.formattedAddress || place.displayName || fallbackLabel);
    } catch (error) {
      console.error("[Google Maps autocomplete] Place details failed", error);
      updateValue(fallbackLabel);
    } finally {
      sessionTokenRef.current = null;
      setSearching(false);
    }
  };

  const displayedValue = value ?? currentValue;

  return (
    <div ref={rootRef} className="relative">
      <input
        name={name}
        className={className}
        required={required}
        value={displayedValue}
        onChange={(event) => {
          const next = event.target.value;
          updateValue(next);
          queuePredictions(next);
        }}
        onFocus={() => {
          if (displayedValue.trim().length >= MIN_QUERY_LENGTH) queuePredictions(displayedValue);
        }}
        onKeyDown={(event) => {
          if (!predictions.length) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, predictions.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter" && activeIndex >= 0) {
            event.preventDefault();
            void selectPrediction(predictions[activeIndex]);
          } else if (event.key === "Escape") {
            setPredictions([]);
            setActiveIndex(-1);
          }
        }}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={predictions.length > 0}
        aria-controls={`${name}-place-predictions`}
        aria-activedescendant={
          activeIndex >= 0 ? `${name}-place-prediction-${activeIndex}` : undefined
        }
      />

      {predictions.length > 0 && (
        <div
          id={`${name}-place-predictions`}
          role="listbox"
          className="relative z-50 mt-1 max-h-64 overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
        >
          {predictions.map((prediction, index) => {
            const main = prediction.mainText?.toString() || predictionLabel(prediction);
            const secondary = prediction.secondaryText?.toString();
            return (
              <button
                key={`${predictionLabel(prediction)}-${index}`}
                id={`${name}-place-prediction-${index}`}
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                className={`block w-full touch-manipulation rounded-md px-3 py-3 text-left text-sm ${
                  activeIndex === index ? "bg-accent text-accent-foreground" : "hover:bg-accent/70"
                }`}
                onPointerDown={(event) => {
                  event.preventDefault();
                  void selectPrediction(prediction);
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="block font-medium">{main}</span>
                {secondary && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">{secondary}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {mode === "loading" && (
        <p className="mt-1 text-[11px] text-muted-foreground" aria-live="polite">
          Loading address suggestions…
        </p>
      )}
      {mode === "ready" && searching && (
        <p className="mt-1 text-[11px] text-muted-foreground" aria-live="polite">
          Finding places…
        </p>
      )}
      {mode === "fallback" && loadError && (
        <div className="mt-1 flex items-start justify-between gap-3" aria-live="polite">
          <p className="text-xs text-amber-300">
            Google address suggestions unavailable: {loadError} You can still type the location
            manually.
          </p>
          <button
            type="button"
            className="shrink-0 text-xs font-medium text-primary hover:underline"
            onClick={() => setRetryKey((current) => current + 1)}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
