export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

export const SplitBorder = {
  border: ["left" as const, "right" as const],
  customBorderChars: {
    ...EmptyBorder,
    vertical: "┃",
  },
}

// The conversation's two gutters. A user turn carries a slim accent bar; tool output and
// errors hang off a hairline in a quiet colour, so the eye can follow one column down.
export const PromptGutter = {
  ...EmptyBorder,
  vertical: "▎",
}

export const HairlineGutter = {
  ...EmptyBorder,
  vertical: "│",
}
