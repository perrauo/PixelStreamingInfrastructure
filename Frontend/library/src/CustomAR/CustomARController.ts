// Copyright Epic Games, Inc. All Rights Reserved.

import { Logger } from '@epicgames-ps/lib-pixelstreamingcommon-ue5.5';
import { WebRtcPlayerController } from '../WebRtcPlayer/WebRtcPlayerController';
import { XRGamepadController } from '../Inputs/XRGamepadController';
import { XrFrameEvent } from '../Util/EventEmitter'
import { Flags } from '../pixelstreamingfrontend';

export class CustomARController {
    public gl: WebGL2RenderingContext;
    public xrSession: XRSession;
    private xrRefSpace: XRReferenceSpace;
    private xrViewerPose : XRViewerPose = null;
    // Used for comparisons to ensure two numbers are close enough.
    private EPSILON = 0.0000001;

    private webRtcController: WebRtcPlayerController;
    private xrGamepadController: XRGamepadController;

    onSessionStarted: EventTarget;
    onSessionEnded: EventTarget;
    onFrame: EventTarget;    

    constructor(webRtcPlayerController: WebRtcPlayerController) {
        this.xrSession = null;
        this.webRtcController = webRtcPlayerController;
        this.xrGamepadController = new XRGamepadController(
            this.webRtcController.streamMessageController
        );
        this.onSessionEnded = new EventTarget();
        this.onSessionStarted = new EventTarget();
        this.onFrame = new EventTarget();
    }

    public startSession(gl: WebGL2RenderingContext) {
        if (!this.xrSession) 
        {
            this.gl = gl;
            navigator.xr
                /* Request immersive-ar session without any optional features. */
                .requestSession('immersive-ar', { 
                    optionalFeatures: ['hit-test'] ,
                    requiredFeatures: ['local']
                })
                .then((session: XRSession) => {
                    this.onXrSessionStarted(session);
                });
        } else 
        {
            this.xrSession.end();
        }
    }

    onXrSessionEnded() {
        Logger.Log(Logger.GetStackTrace(), 'XR Session ended');
        this.xrSession = null;
        this.onSessionEnded.dispatchEvent(new Event('xrSessionEnded'));
    }


    onXrSessionStarted(session: XRSession) {
        Logger.Log(Logger.GetStackTrace(), 'XR Session started');

        this.xrSession = session;
        this.xrSession.addEventListener('end', () => {
            this.onXrSessionEnded();
        });

        Logger.Log(Logger.GetStackTrace(), 'XR ' + this.xrSession.visibilityState);

        session.requestReferenceSpace('local').then((refSpace) => {
            Logger.Log(Logger.GetStackTrace(), 'XR requestReferenceSpace');

            this.xrRefSpace = refSpace;
            Logger.Log(Logger.GetStackTrace(), 'XR requestReferenceSpace name:' + refSpace);

            // Set up our base layer (i.e. a projection layer that fills the entire XR viewport).
            this.xrSession.updateRenderState({
                baseLayer: new XRWebGLLayer(this.xrSession, this.gl)
            });

            // Update target framerate to 90 fps if 90 fps is supported in this XR device
            if(this.xrSession.supportedFrameRates) {
                for (const frameRate of this.xrSession.supportedFrameRates) {
                    if(frameRate == 90){
                        session.updateTargetFrameRate(90);
                    }
                }
            }

            // Binding to each new frame to get latest XR updates
            this.xrSession.requestAnimationFrame(this.onXrFrame.bind(this));
        });

        this.onSessionStarted.dispatchEvent(new Event('xrSessionStarted'));
    }

    areArraysEqual(a: Float32Array, b: Float32Array) : boolean {
        return a.length === b.length && a.every((element, index) => Math.abs(element - b[index]) <= this.EPSILON);
    }

    arePointsEqual(a: DOMPointReadOnly, b: DOMPointReadOnly) : boolean {
        return Math.abs(a.x - b.x) >= this.EPSILON && Math.abs(a.y - b.y) >= this.EPSILON && Math.abs(a.z - b.z) >= this.EPSILON;
    }

    sendXRDataToUE() {
        
        const trans = this.xrViewerPose.transform.matrix;

        // If we don't need to the entire eye views being sent just send the transform
        this.webRtcController.streamMessageController.toStreamerHandlers.get('CustomArTransform')([
            // 4x4 transform
            trans[0], trans[4], trans[8],  trans[12],
            trans[1], trans[5], trans[9],  trans[13],
            trans[2], trans[6], trans[10], trans[14],
            trans[3], trans[7], trans[11], trans[15],
        ]);
    }

    onXrFrame(time: DOMHighResTimeStamp, frame: XRFrame) {
        
        Logger.Log(Logger.GetStackTrace(), 'XR onXrFrame');

        this.xrViewerPose = frame.getViewerPose(this.xrRefSpace);
        
        if (this.xrViewerPose) {
            Logger.Log(Logger.GetStackTrace(), 'XR xrViewerPose');
            this.sendXRDataToUE();
        }

        if (this.webRtcController.config.isFlagEnabled(Flags.XRControllerInput)) {
            this.xrSession.inputSources.forEach(
                (source: XRInputSource, _index: number, _array: XRInputSource[]) => {
                    this.xrGamepadController.updateStatus(
                        source,
                        frame,
                        this.xrRefSpace
                    );
                },
                this
            );
        }

        this.xrSession.requestAnimationFrame(
            (time: DOMHighResTimeStamp, frame: XRFrame) =>
                this.onXrFrame(time, frame)
        );

        this.onFrame.dispatchEvent(new XrFrameEvent({ time, frame }));
    }

    static isSessionSupported(mode: XRSessionMode): Promise<boolean> {
        if (location.protocol !== "https:") {
            Logger.Info(null, "WebXR requires https, if you want WebXR use https.");
        }

        if (navigator.xr) {
            return navigator.xr.isSessionSupported(mode);
        } else {
            return new Promise<boolean>(() => {
                return false;
            });
        }
    }
}
