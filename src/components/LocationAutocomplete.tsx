"use client";

import { useEffect, useRef, useState } from "react";

type GooglePlace = {
  displayName?: string;
  formattedAddress?: string;
  fetchFields(options: { fields: string[] }): Promise<void>;
};

type PlaceAutocompleteElement = HTMLElement & {
  includedRegionCodes: string[];
  locationBias: { center: { lat: number; lng: number }; radius: number };
  name: string;
  placeholder: string;
  required: boolean;
  value: string;
};

type PlacesLibrary = {
  PlaceAutocompleteElement: new () => PlaceAutocompleteElement;
};

type GoogleMapsWindow = Window & {
  google?: { maps?: { importLibrary(name: string): Promise<unknown> } };
  __denagoGoogleMapsReady?: () => void;
};

let placesLibraryPromise: Promise<PlacesLibrary | null> | null = null;

async function getPlacesLibrary(): Promise<PlacesLibrary | null> {
  if (placesLibraryPromise) return placesLibraryPromise;

  placesLibraryPromise = (async () => {
    try {
      const response = await fetch("/api/integrations/google-maps", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) return null;
      const config = (await response.json()) as { apiKey?: string | null };
      if (!config.apiKey) return null;
      const apiKey = config.apiKey;

      const mapsWindow = window as GoogleMapsWindow;
      if (!mapsWindow.google?.maps?.importLibrary) {
        await new Promise<void>((resolve, reject) => {
          // If we're here, importLibrary isn't ready, so any existing marked
          // script is a DEAD one from a prior failed attempt (a successful load
          // would have set importLibrary and skipped this block). Never re-attach
          // to it — its load/error already fired and would never fire again,
          // hanging forever. Remove it and always load a fresh, deterministic one.
          document
            .querySelectorAll('script[data-denago-google-maps="true"]')
            .forEach((stale) => stale.remove());

          const script = document.createElement("script");
          const cleanup = () => {
            script.remove();
            delete mapsWindow.__denagoGoogleMapsReady;
          };
          mapsWindow.__denagoGoogleMapsReady = () => resolve();
          script.dataset.denagoGoogleMaps = "true";
          script.async = true;
          script.onerror = () => {
            // Leave no failed script behind for the next mount to wait on.
            cleanup();
            reject(new Error("Google Maps failed to load"));
          };
          script.src =
            "https://maps.googleapis.com/maps/api/js?" +
            new URLSearchParams({
              key: apiKey,
              loading: "async",
              libraries: "places",
              callback: "__denagoGoogleMapsReady",
              v: "weekly",
            });
          document.head.appendChild(script);
        });
      }

      const library = await mapsWindow.google?.maps?.importLibrary("places");
      return (library as PlacesLibrary | undefined) ?? null;
    } catch {
      return null;
    }
  })();

  const library = await placesLibraryPromise;
  // A missing/failed key must not poison the browser session. This allows an
  // owner to save the key in Settings and use autocomplete on the next mount.
  if (!library) placesLibraryPromise = null;
  return library;
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
  const [currentValue, setCurrentValue] = useState(value ?? defaultValue);
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<PlaceAutocompleteElement | null>(null);
  const latestValueRef = useRef(currentValue);

  useEffect(() => {
    if (value === undefined) return;
    latestValueRef.current = value;
    if (widgetRef.current) widgetRef.current.value = value;
  }, [value]);

  useEffect(() => {
    let disposed = false;
    let widget: PlaceAutocompleteElement | null = null;

    void getPlacesLibrary().then((library) => {
      if (disposed || !library || !hostRef.current) {
        if (!disposed) setMode("fallback");
        return;
      }

      widget = new library.PlaceAutocompleteElement();
      widgetRef.current = widget;
      widget.name = name;
      widget.required = required;
      widget.placeholder = placeholder;
      widget.value = latestValueRef.current;
      widget.includedRegionCodes = ["za"];
      widget.locationBias = { center: { lat: -33.925, lng: 18.48 }, radius: 100_000 };
      widget.className = className;
      widget.style.display = "block";
      widget.style.width = "100%";
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
        onValueChange?.(next);
      };
      const handleInput = () => updateValue(widget?.value ?? "");
      const handleSelect = async (event: Event) => {
        const prediction = (event as Event & {
          placePrediction?: { toPlace(): GooglePlace };
        }).placePrediction;
        if (!prediction) return;
        const place = prediction.toPlace();
        try {
          await place.fetchFields({ fields: ["displayName", "formattedAddress"] });
        } catch {
          return;
        }
        const selected = place.formattedAddress || place.displayName || widget?.value || "";
        if (widget) widget.value = selected;
        updateValue(selected);
      };
      const handleError = () => {
        widget?.remove();
        widgetRef.current = null;
        setMode("fallback");
      };

      widget.addEventListener("input", handleInput);
      widget.addEventListener("gmp-select", handleSelect);
      widget.addEventListener("gmp-error", handleError);
      hostRef.current.replaceChildren(widget);
      setMode("ready");
    });

    return () => {
      disposed = true;
      widget?.remove();
      widgetRef.current = null;
    };
  }, [className, name, onValueChange, placeholder, required]);

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
            onValueChange?.(next);
          }}
          placeholder={placeholder}
          autoComplete="street-address"
        />
      )}
      <div ref={hostRef} className={mode === "ready" ? "block" : "hidden"} />
    </>
  );
}
