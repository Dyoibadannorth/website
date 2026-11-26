import { loadFaceModels, detectFace } from "../utils/faceDetection";

/**
 * The profile photo is what lands on every attendance card, so it gets the
 * same face-detect crop the old registration form used: a 1000×1000 JPEG
 * centred on the face. Used by the sign-up page and the account page.
 */
export async function cropToFace(file: File): Promise<File> {
  const unreadable = () => new Error("That photo couldn't be opened. Try a JPG or PNG photo.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(unreadable());
    r.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(unreadable());   // e.g. an iPhone HEIC photo in a browser that can't show it
    i.src = dataUrl;
  });

  await loadFaceModels();
  const box = await detectFace(img);
  if (!box) throw new Error("We couldn't find a face in that photo. Try a clearer, front-facing one.");

  const size = Math.max(box.width, box.height) * 1.6;
  const startX = Math.max(0, box.x + box.width / 2 - size / 2);
  const startY = Math.max(0, box.y + box.height / 2 - size / 2);

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1000;
  canvas.getContext("2d")!.drawImage(img, startX, startY, size, size, 0, 0, 1000, 1000);

  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.85));

  return new File([blob], "profile.jpg", { type: "image/jpeg" });
}