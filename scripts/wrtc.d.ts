// wrtc'ning rasmiy TypeScript turlari yo'q — bu yuklama-test skripti uchun
// minimal deklaratsiya (faqat kerakli qismlar, `any` orqali ishlatiladi).
declare module "wrtc" {
  const wrtc: {
    RTCPeerConnection: unknown
    MediaStream: unknown
    MediaStreamTrack: unknown
    nonstandard: {
      RTCVideoSource: new () => { createTrack(): MediaStreamTrack; onFrame(frame: unknown): void }
      RTCAudioSource: new () => { createTrack(): MediaStreamTrack; onData(data: unknown): void }
    }
  }
  export default wrtc
}
