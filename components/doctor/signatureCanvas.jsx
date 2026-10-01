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
  const lastMid = useRef(null);
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
    const p = getPos(e);
    lastPoint.current = p;
    lastMid.current = p;
    lastTime.current = e.nativeEvent.timeStamp;
    currentWidth.current = 2.2;
    e.preventDefault();
  };

  const move = (e) => {
    if (!drawing.current || !lastPoint.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d");

    // Browsers batch pointer moves between frames; coalesced events give us
    // every sample, which is what keeps fast strokes from looking polygonal.
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const events = coalesced.length ? coalesced : [e.nativeEvent];

    for (const ev of events) {
      const point = getPos(ev);
      const distance = Math.hypot(
        point.x - lastPoint.current.x,
        point.y - lastPoint.current.y,
      );
      if (distance < 1) continue; // ignore sub-pixel jitter

      const dt = Math.max(ev.timeStamp - (lastTime.current ?? ev.timeStamp), 1);
      const speed = distance / dt; // px per ms

      // Faster strokes read as lighter pen pressure (thinner), slower,
      // deliberate strokes (loops, the start/end of a name) read as thicker.
      // Smoothed against the last width so it doesn't jump between segments.
      const targetWidth = clamp(2.8 - speed * 3.5, 1.1, 2.8);
      currentWidth.current = currentWidth.current * 0.7 + targetWidth * 0.3;

      const mid = {
        x: (lastPoint.current.x + point.x) / 2,
        y: (lastPoint.current.y + point.y) / 2,
      };

      // Start from the PREVIOUS midpoint, with the previous raw point as the
      // control point. Consecutive curves share an endpoint, so the line is
      // continuous instead of broken into disconnected pieces.
      ctx.lineWidth = currentWidth.current;
      ctx.beginPath();
      ctx.moveTo(lastMid.current.x, lastMid.current.y);
      ctx.quadraticCurveTo(
        lastPoint.current.x,
        lastPoint.current.y,
        mid.x,
        mid.y,
      );
      ctx.stroke();

      lastMid.current = mid;
      lastPoint.current = point;
      lastTime.current = ev.timeStamp;
      emptyRef.current = false;
      setIsEmpty(false);
    }
  };

  const end = (e) => {
    if (drawing.current && lastPoint.current && lastMid.current) {
      // Finish the tail from the last midpoint to the final point. If the
      // user just tapped, this draws a dot thanks to the round line cap.
      const ctx = canvasRef.current.getContext("2d");
      ctx.lineWidth = currentWidth.current;
      ctx.beginPath();
      ctx.moveTo(lastMid.current.x, lastMid.current.y);
      ctx.lineTo(lastPoint.current.x, lastPoint.current.y);
      ctx.stroke();
      emptyRef.current = false;
      setIsEmpty(false);
    }
    drawing.current = false;
    lastPoint.current = null;
    lastMid.current = null;
    lastTime.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  useImperativeHandle(ref, () => ({
    clear: () => {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      lastPoint.current = null;
      lastMid.current = null;
      lastTime.current = null;
      currentWidth.current = 2.2;
      emptyRef.current = true;
      setIsEmpty(true);
    },
    isEmpty: () => emptyRef.current,
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
