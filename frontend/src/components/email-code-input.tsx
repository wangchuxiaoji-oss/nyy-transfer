"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";

interface EmailCodeInputProps {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  disabled?: boolean;
  className?: string;
}

export function EmailCodeInput({
  value,
  onChange,
  length = 6,
  disabled = false,
  className = "",
}: EmailCodeInputProps) {
  const [digits, setDigits] = useState<string[]>(() => {
    const arr = Array(length).fill("");
    for (let i = 0; i < Math.min(value.length, length); i++) {
      arr[i] = value[i];
    }
    return arr;
  });
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // 同步外部 value
  useEffect(() => {
    const arr = Array(length).fill("");
    for (let i = 0; i < Math.min(value.length, length); i++) {
      arr[i] = value[i];
    }
    setDigits(arr);
  }, [value, length]);

  const updateDigits = useCallback(
    (newDigits: string[]) => {
      setDigits(newDigits);
      onChange(newDigits.join(""));
    },
    [onChange]
  );

  const focusInput = useCallback(
    (index: number) => {
      if (index >= 0 && index < length) {
        inputRefs.current[index]?.focus();
        inputRefs.current[index]?.select();
      }
    },
    [length]
  );

  const handleInput = useCallback(
    (index: number, val: string) => {
      const digit = val.replace(/\D/g, "").slice(-1);
      const newDigits = [...digits];
      newDigits[index] = digit;
      updateDigits(newDigits);
      if (digit && index < length - 1) {
        focusInput(index + 1);
      }
    },
    [digits, length, updateDigits, focusInput]
  );

  const handleKeyDown = useCallback(
    (index: number, e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Backspace") {
        if (!digits[index] && index > 0) {
          const newDigits = [...digits];
          newDigits[index - 1] = "";
          updateDigits(newDigits);
          focusInput(index - 1);
        } else {
          const newDigits = [...digits];
          newDigits[index] = "";
          updateDigits(newDigits);
        }
        e.preventDefault();
      } else if (e.key === "ArrowLeft" && index > 0) {
        focusInput(index - 1);
        e.preventDefault();
      } else if (e.key === "ArrowRight" && index < length - 1) {
        focusInput(index + 1);
        e.preventDefault();
      }
    },
    [digits, length, updateDigits, focusInput]
  );

  const handlePaste = useCallback(
    (index: number, e: ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const text = e.clipboardData.getData("text");
      const numbers = text.replace(/\D/g, "").slice(0, length);
      if (!numbers) return;

      const newDigits = numbers.length >= length ? Array(length).fill("") : [...digits];
      const start = numbers.length >= length ? 0 : index;
      for (let i = 0; i < numbers.length; i++) {
        const target = start + i;
        if (target < length) newDigits[target] = numbers[i];
      }
      updateDigits(newDigits);

      // 聚焦到最后一个填入的位置
      const focusIdx = Math.min(start + numbers.length - 1, length - 1);
      focusInput(focusIdx);
    },
    [digits, length, updateDigits, focusInput]
  );

  const inputCls =
    "retro-input type-section w-11 h-14 text-center tracking-[0.3em] font-mono";

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            inputRefs.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={1}
          value={digit}
          disabled={disabled}
          onChange={(e) => handleInput(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={(e) => handlePaste(i, e)}
          className={inputCls}
          aria-label={`验证码第 ${i + 1} 位`}
        />
      ))}
    </div>
  );
}
