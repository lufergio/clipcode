import { Suspense } from "react";
import OpenPairClient from "./open-pair-client";

function OpenPairFallback() {
  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-10 text-neutral-50">
      <div className="mx-auto max-w-md rounded-2xl bg-neutral-900 p-5 ring-1 ring-neutral-800">
        <h1 className="text-lg font-semibold">Preparando apertura...</h1>
      </div>
    </main>
  );
}

export default function OpenPairPage() {
  return (
    <Suspense fallback={<OpenPairFallback />}>
      <OpenPairClient />
    </Suspense>
  );
}
