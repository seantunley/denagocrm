"use client";

import { useEffect, useRef, useState } from "react";

type GooglePlace = {
  displayName?: string;
  formattedAddress?: string;
  fetchFields(options: { fields: string[] }): Promise<void>;
};

type PlacePrediction = {
  text?: { toString(): string };
  toPlace(): GooglePlace;
};

type PlaceAutocompleteElementOptions = {
  includedRegionCodes?: string[];
  locationBias?: { center: { lat: number; lng: number }; radius: number };
  placeholder?: string;
  requestedLanguage?: string;
  requestedRegion?: string;
  value?: string;
};

type PlaceAutocompleteElement = HTMLElement & {
  name: string;
  placeholder: string;
  required: boolean;
  value: string;
};

type PlacesLibrary = {
  PlaceAutocompleteElement: new (
    options?: PlaceAutocompleteElementOptions,
  ) => PlaceAutocompleteElement;
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
    // A failed or interrupted loader must never be reused. Its terminal event has
    // already fired, so attaching listeners to it would leave this promise hanging.
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
      if (!library || typeof library.PlaceAutocompleteElement !== "function") {
        throw new Error(
          "Google loaded without Place Autocomplete. Enable Maps JavaScript API and Places API (New) on this key's project.",
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
  // Failed configuration or a temporary browser/network error must not poison the
  // whole tab. A retry or later mount should perform a completely fresh attempt.
  if (!result.library) placesLibraryPromise = null;
  return result;
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
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<PlaceAutocompleteElement | null>(null);
  const latestValueRef = useRef(currentValue);
  const onValueChangeRef = useRef(onValueChange);

  useEffect(() => {
    onValueChangeRef.current = onValueChange;
  }, [onValueChange]);

  useEffect(() => {
    if (value === undefined) return;
    latestValueRef.current = value;
    if (widgetRef.current) widgetRef.current.value = value;
  }, [value]);

  useEffect(() => {
    let disposed = false;
    let widget: PlaceAutocompleteElement | null = null;

    const useFallback = (message: string) => {
      if (disposed) return;
      widget?.remove();
      widgetRef.current = null;
      setLoadError(message);
      setMode("fallback");
    };

    const handleGlobalError = (event: Event) => {
      const message =
        event instanceof CustomEvent && typeof event.detail === "string"
          ? event.detail
          : "Google Maps rejected the autocomplete request.";
      useFallback(message);
    };

    window.addEventListener(MAPS_ERROR_EVENT, handleGlobalError);
    setMode("loading");
    setLoadError(null);

    void getPlacesLibrary().then(({ library, error }) => {
      if (disposed || !hostRef.current) return;
      if (!library) {
        useFallback(error ?? "Google Maps autocomplete is unavailable.");
        return;
      }

      try {
        widget = new library.PlaceAutocompleteElement({
          includedRegionCodes: ["za"],
          locationBias: {
            center: { lat: -33.925, lng: 18.48 },
            radius: 100_000,
          },
          placeholder,
          requestedLanguage: "en",
          requestedRegion: "za",
          value: latestValueRef.current,
        });
        widgetRef.current = widget;
        widget.name = name;
        widget.required = required;
        widget.placeholder = placeholder;
        widget.value = latestValueRef.current;
        widget.className = className;
        widget.style.display = "block";
        widget.style.width = "100%";
        widget.style.minHeight = "2.5rem";
        widget.style.colorScheme = "dark";
        widget.style.backgroundColor = "var(--card)";
        widget.style.border = "1px solid var(--input)";
        widget.style.borderRadius = "var(--radius-md)";
        widget.style.color = "var(--foreground)";
        widget.style.font = "inherit";
        widget.style.fontSize = "0.875rem";

        const updateValue = (next: string) => {
          latestValueRef.current = next;
          setCurrentValue(next);
          onValueChangeRef.current?.(next);
        };
        const handleInput = () => updateValue(widget?.value ?? "");
        const handleSelect = async (event: Event) => {
          const prediction = (event as Event & {
            placePrediction?: PlacePrediction;
          }).placePrediction;
          if (!prediction) return;

          const predictionText = prediction.text?.toString() ?? widget?.value ?? "";
          const place = prediction.toPlace();
          try {
            await place.fetchFields({ fields: ["displayName", "formattedAddress"] });
          } catch (selectionError) {
            console.error("[Google Maps autocomplete] Place details failed", selectionError);
          }

          const selected =
            place.formattedAddress || place.displayName || predictionText || widget?.value || "";
          if (widget) widget.value = selected;
          updateValue(selected);
        };
        const handleRequestError = () => {
          useFallback(
            "Google denied the Places request. Check the browser key's referrer and API restrictions in Google Cloud.",
          );
        };

        widget.addEventListener("input", handleInput);
        widget.addEventListener("gmp-select", handleSelect);
        widget.addEventListener("gmp-error", handleRequestError);
        hostRef.current.replaceChildren(widget);
        setMode("ready");
      } catch (errorDuringWidgetSetup) {
        useFallback(`Google Places widget setup failed: ${errorMessage(errorDuringWidgetSetup)}`);
      }
    });

    return () => {
      disposed = true;
      window.removeEventListener(MAPS_ERROR_EVENT, handleGlobalError);
      widget?.remove();
      widgetRef.current = null;
    };
  }, [className, name, placeholder, required, retryKey]);

  return (
    <>
      {mode !== "ready" && (
        <input
          name={name}
          className={className}
          required={required}
          value={value ?? currentValue}
          onChange={(event) => {
            const next = event.target.value;
            latestValueRef.current = next;
            setCurrentValue(next);
            onValueChangeRef.current?.(next);
          }}
          placeholder={placeholder}
          autoComplete="street-address"
        />
      )}
      <div ref={hostRef} className={mode === "ready" ? "block" : "hidden"} />
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
    </>
  );
}
