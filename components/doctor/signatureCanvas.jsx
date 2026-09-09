import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

// A minimal, dependency-free signature pad. The small PNG data URL is saved
// on the user's Firestore profile and used to build the local referral JPEG.
const SignatureCanvas = forwardRef(function SignatureCanvas(
  { height = 180 },
  ref,
) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const lastPoint = useRef(null);
  const lastTime = useRef(null);
  const currentWidth = useRef(2.2);
  const resizeObserver = useRef(null);
  const emptyRef = useRef(true);
  const [isEmpty, setIsEmpty] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    const resize = () => {
      // Cap the effective pixel ratio: raw devicePixelRatio on some phones
      // (3x, 4x) produces a much larger PNG than the signature needs once
      // it's scaled into the ~440x150 box on the downloaded form, and that
      // extra weight gets stored inline on the Firestore user doc.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const cssWidth = canvas.clientWidth;
      const existing = canvas.toDataURL("image/png");
      canvas.width = Math.max(1, Math.round(cssWidth * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      const ctx = canvas.getContext("2d");
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      // A deep ink navy reads as a real signature; the previous pale
      // blue-grey looked like a light sketch even after boosting contrast
      // downstream on the printed form.
      ctx.strokeStyle = "#1a2340";
      if (existing !== "data:," && !emptyRef.current) {
        const image = new Image();
        image.onload = () => ctx.drawImage(image, 0, 0, cssWidth, height);
        image.src = existing;
      }
    };

    resize();
    resizeObserver.current = new ResizeObserver(resize);
    resizeObserver.current.observe(canvas);
    return () => resizeObserver.current?.disconnect();
  }, [height]);

  const getPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const start = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drawing.current = true;
    lastPoint.current = getPos(e);
    lastTime.current = performance.now();
    currentWidth.current = 2.2;
    e.preventDefault();
  };

  const move = (e) => {
    if (!drawing.current || !lastPoint.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    const point = getPos(e);
    const now = performance.now();
    const dt = Math.max(now - (lastTime.current ?? now), 1);
    const distance = Math.hypot(
      point.x - lastPoint.current.x,
      point.y - lastPoint.current.y,
    );
    const speed = distance / dt; // px per ms

    // Faster strokes read as lighter pen pressure (thinner), slower,
    // deliberate strokes (loops, the start/end of a name) read as thicker —
    // this is what makes a drawn signature look human instead of a
    // uniform-width vector trace. Smoothed against the last width so it
    // doesn't jump abruptly between segments.
    const targetWidth = clamp(2.8 - speed * 3.5, 1.1, 2.8);
    currentWidth.current = currentWidth.current * 0.7 + targetWidth * 0.3;

    const midpoint = {
      x: (lastPoint.current.x + point.x) / 2,
      y: (lastPoint.current.y + point.y) / 2,
    };
    ctx.lineWidth = currentWidth.current;
    ctx.beginPath();
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
    ctx.quadraticCurveTo(point.x, point.y, midpoint.x, midpoint.y);
    ctx.stroke();
    lastPoint.current = point;
    lastTime.current = now;
    emptyRef.current = false;
    setIsEmpty(false);
  };

  const end = (e) => {
    drawing.current = false;
    lastPoint.current = null;
    lastTime.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  useImperativeHandle(ref, () => ({
    clear: () => {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      lastPoint.current = null;
      lastTime.current = null;
      currentWidth.current = 2.2;
      emptyRef.current = true;
      setIsEmpty(true);
    },
    isEmpty: () => isEmpty,
    // Returns a transparent PNG data URL ready for upload.
    toTransparentPNG: () => canvasRef.current.toDataURL("image/png"),
  }));

  return (
    <canvas
      ref={canvasRef}
      style={{ height }}
      className="w-full cursor-crosshair touch-none rounded-md border border-dashed border-slate-300 bg-white"
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export default SignatureCanvas;
