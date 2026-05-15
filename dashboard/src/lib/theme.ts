export type Theme = "dark" | "light";

export type ThemeClasses = ReturnType<typeof getThemeClasses>;

export function getThemeClasses(theme: Theme) {
  if (theme === "light") {
    return {
      page: "bg-[#f4f7ef] text-[#11170f]",
      header: "border-stone-300 bg-[#fbfcf7]/95",
      card: "border-stone-300 bg-white text-[#11170f] shadow-black/5",
      subtlePanel: "border-stone-200 bg-[#f5f7ef]",
      toast: "border-stone-300 bg-white text-[#11170f]",
      heading: "text-[#11170f]",
      secondaryText: "text-stone-600",
      mutedText: "text-stone-500",
      accentText: "text-emerald-700",
      primaryButton: "bg-[#11170f] text-white hover:bg-emerald-900",
      paperTradeButton: "bg-[#11170f] text-white hover:bg-emerald-900",
      outlineButton:
        "border-stone-300 bg-white text-stone-700 hover:border-emerald-700 hover:text-emerald-800",
      successButton: "border border-emerald-700/30 bg-emerald-100 text-emerald-800",
      symbolPill: "border-emerald-700/30 text-emerald-800",
      convictionBox: "border-emerald-700/30 bg-emerald-50",
      bullishPill: "bg-emerald-100 text-emerald-800",
      bearishPill: "bg-red-100 text-red-800",
      positiveText: "text-emerald-700",
      negativeText: "text-red-700",
      amberText: "text-amber-700",
      shortPill: "bg-red-600 text-white shadow-sm",
      longPill: "bg-emerald-600 text-white shadow-sm",
      executionPlan: "border-emerald-700/40 bg-[#fbfcf7]",
      executionPlanHeader: "border-emerald-700/20 bg-emerald-50 text-emerald-900",
      qualityGood: "bg-emerald-100 text-emerald-800 border-emerald-700/30",
      qualityMarginal: "bg-amber-100 text-amber-800 border-amber-700/30",
      qualityPoor: "bg-red-100 text-red-800 border-red-700/30",
      freshnessFresh: "text-emerald-700",
      freshnessAging: "text-amber-700",
      freshnessStale: "text-red-700",
      qtyInput:
        "border-stone-300 bg-white text-[#11170f] focus:border-emerald-700 focus:ring-emerald-500/30",
    };
  }

  return {
    page: "bg-[#070907] text-stone-100",
    header: "border-lime-300/10 bg-[#0b0f0b]/95",
    card: "border-stone-800 bg-[#0d120d] text-stone-100 shadow-black/20",
    subtlePanel: "border-stone-800 bg-black/20",
    toast: "border-stone-700 bg-[#101510] text-stone-200",
    heading: "text-stone-50",
    secondaryText: "text-stone-400",
    mutedText: "text-stone-500",
    accentText: "text-lime-300",
    primaryButton: "bg-lime-300 text-[#10140f] hover:bg-lime-200",
    paperTradeButton: "bg-stone-100 text-[#10140f] hover:bg-lime-200",
    outlineButton:
      "border-stone-700 bg-stone-900 text-stone-300 hover:border-lime-300/50 hover:text-lime-200",
    successButton: "border border-emerald-300/30 bg-emerald-300/10 text-emerald-200",
    symbolPill: "border-lime-300/30 text-lime-200",
    convictionBox: "border-lime-300/30 bg-lime-300/5",
    bullishPill: "bg-emerald-400/10 text-emerald-300",
    bearishPill: "bg-red-400/10 text-red-300",
    positiveText: "text-emerald-300",
    negativeText: "text-red-300",
    amberText: "text-amber-300",
    shortPill: "bg-red-500 text-white shadow-md shadow-red-500/30",
    longPill: "bg-emerald-500 text-[#10140f] shadow-md shadow-emerald-500/30",
    executionPlan: "border-lime-300/30 bg-[#0a0f0a]",
    executionPlanHeader: "border-lime-300/20 bg-lime-300/5 text-lime-200",
    qualityGood: "bg-emerald-400/15 text-emerald-200 border-emerald-300/30",
    qualityMarginal: "bg-amber-400/15 text-amber-200 border-amber-300/30",
    qualityPoor: "bg-red-400/15 text-red-200 border-red-300/30",
    freshnessFresh: "text-emerald-300",
    freshnessAging: "text-amber-300",
    freshnessStale: "text-red-300",
    qtyInput:
      "border-stone-700 bg-black/30 text-stone-100 focus:border-lime-300 focus:ring-lime-300/30",
  };
}
