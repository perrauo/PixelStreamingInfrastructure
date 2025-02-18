// Copyright Epic Games, Inc. All Rights Reserved.

import { Config, OptionParameters } from '../Config/Config';
import { LatencyTestResults } from '../DataChannel/LatencyTestResults';
import { AggregatedStats } from '../PeerConnectionController/AggregatedStats';
import { WebRtcPlayerController } from '../WebRtcPlayer/WebRtcPlayerController';
import { Flags, NumericParameters } from '../Config/Config';
import { Logger } from '@epicgames-ps/lib-pixelstreamingcommon-ue5.5';
import { InitialSettings } from '../DataChannel/InitialSettings';
import { OnScreenKeyboard } from '../UI/OnScreenKeyboard';
import {
    EventEmitter,
    InitialSettingsEvent,
    LatencyTestResultEvent,
    PixelStreamingEvent,
    StatsReceivedEvent,
    StreamLoadingEvent,
    StreamPreConnectEvent,
    StreamReconnectEvent,
    StreamPreDisconnectEvent,
    VideoEncoderAvgQPEvent,
    VideoInitializedEvent,
    WebRtcAutoConnectEvent,
    WebRtcConnectedEvent,
    WebRtcConnectingEvent,
    WebRtcDisconnectedEvent,
    WebRtcFailedEvent,
    WebRtcSdpEvent,
    DataChannelLatencyTestResponseEvent,
    DataChannelLatencyTestResultEvent,
    PlayerCountEvent,
    WebRtcTCPRelayDetectedEvent
} from '../Util/EventEmitter';
import { WebXRController } from '../WebXR/WebXRController';
import { CustomARController } from '../CustomAR/CustomARController';
import { MessageDirection } from '../UeInstanceMessage/StreamMessageController';
import {
    DataChannelLatencyTestConfig,
    DataChannelLatencyTestController
} from "../DataChannel/DataChannelLatencyTestController";
import {
    DataChannelLatencyTestResponse,
    DataChannelLatencyTestResult
} from "../DataChannel/DataChannelLatencyTestResults";
import { RTCUtils } from '../Util/RTCUtils';
import { IURLSearchParams } from '../Util/IURLSearchParams';


export interface PixelStreamingOverrides {
    /** The DOM element where Pixel Streaming video and user input event handlers are attached to.
     * You can give an existing DOM element here. If not given, the library will create a new div element
     * that is not attached anywhere. In this case you can later get access to this new element and
     * attach it to your web page. */
    videoElementParent?: HTMLElement;
}

/**
 * The key class for the browser side of a Pixel Streaming application, it includes:
 * WebRTC handling, XR support, input handling, and emitters for lifetime and state change events.
 * Users are encouraged to use this class as is, through composition, or extend it. In any case, 
 * this will likely be the core of your Pixel Streaming experience in terms of functionality.
 */
export class PixelStreaming {
    protected _webRtcController: WebRtcPlayerController;
    protected _webXrController: WebXRController;
    protected _customArController: CustomARController;
    protected _dataChannelLatencyTestController: DataChannelLatencyTestController;

    /**
     * Configuration object. You can read or modify config through this object. Whenever
     * the configuration is changed, the library will emit a `settingsChanged` event.
     */
    public config: Config;

    private _videoElementParent: HTMLElement;

    private allowConsoleCommands = false;

    private onScreenKeyboardHelper: OnScreenKeyboard;

    private _videoStartTime: number;
    private _inputController: boolean;

    private _eventEmitter: EventEmitter;

    protected _gl: WebGL2RenderingContext;
    private _videoTexture: WebGLTexture = null;
    
    private _positionLocation: number;
    private _texcoordLocation: number;

    private _positionBuffer: WebGLBuffer;

    
    private _texcoordBuffer: WebGLBuffer;

    private _prevVideoWidth: number = 0;
    private _prevVideoHeight: number = 0;

    private _canvas: HTMLCanvasElement = null;

    /**
     * @param config - A newly instantiated config object
     * @param overrides - Parameters to override default behaviour
     * returns the base Pixel streaming object
     */
    constructor(config: Config, overrides?: PixelStreamingOverrides) {
        this.config = config;

        if (overrides?.videoElementParent) {
            this._videoElementParent = overrides.videoElementParent;
        }

        this._eventEmitter = new EventEmitter();

        this.configureSettings();

        // setup WebRTC
        this.setWebRtcPlayerController(
            new WebRtcPlayerController(this.config, this)
        );

        // Onscreen keyboard
        this.onScreenKeyboardHelper = new OnScreenKeyboard(
            this.videoElementParent
        );
        this.onScreenKeyboardHelper.unquantizeAndDenormalizeUnsigned = (
            x: number,
            y: number
        ) =>
            this._webRtcController.requestUnquantizedAndDenormalizeUnsigned(
                x,
                y
            );
        this._activateOnScreenKeyboard = (command: any) =>
            this.onScreenKeyboardHelper.showOnScreenKeyboard(command);

        this._webXrController = new WebXRController(this._webRtcController);
        this._customArController = new CustomARController(this._webRtcController);

        this._setupWebRtcTCPRelayDetection = this._setupWebRtcTCPRelayDetection.bind(this)

        // Add event listener for the webRtcConnected event
        this._eventEmitter.addEventListener("webRtcConnected", (_: WebRtcConnectedEvent) => {

            // Bind to the stats received event
            this._eventEmitter.addEventListener("statsReceived",  this._setupWebRtcTCPRelayDetection);
        });
    }

    /**
     * Gets the element that contains the video stream element.
     */
    public get videoElementParent(): HTMLElement {
        if (!this._videoElementParent) {
            this._videoElementParent = document.createElement('div');
            this._videoElementParent.id = 'videoElementParent';
        }
        return this._videoElementParent;
    }  

    /**
     * Configure the settings with on change listeners and any additional per experience settings.
     */
    private configureSettings(): void {
        this.config._addOnSettingChangedListener(
            Flags.IsQualityController,
            (wantsQualityController: boolean) => {
                // If the setting has been set to true (either programmatically or the user has flicked the toggle)
                // and we aren't currently quality controller, send the request
                if (
                    wantsQualityController === true &&
                    !this._webRtcController.isQualityController
                ) {
                    this._webRtcController.sendRequestQualityControlOwnership();
                }
            }
        );

        this.config._addOnSettingChangedListener(
            Flags.AFKDetection,
            (isAFKEnabled: boolean) => {
                this._webRtcController.setAfkEnabled(isAFKEnabled);
            }
        );

        this.config._addOnSettingChangedListener(
            Flags.MatchViewportResolution,
            () => {
                this._webRtcController.videoPlayer.updateVideoStreamSize();
            }
        );

        this.config._addOnSettingChangedListener(
            Flags.HoveringMouseMode,
            (isHoveringMouse: boolean) => {
                this.config.setFlagLabel(
                    Flags.HoveringMouseMode,
                    `Control Scheme: ${
                        isHoveringMouse ? 'Hovering' : 'Locked'
                    } Mouse`
                );
                this._webRtcController.setMouseInputEnabled(this.config.isFlagEnabled(Flags.MouseInput));
            }
        );

        // user input
        this.config._addOnSettingChangedListener(
            Flags.KeyboardInput,
            (isEnabled: boolean) => {
                this._webRtcController.setKeyboardInputEnabled(isEnabled);
            }
        );

        this.config._addOnSettingChangedListener(
            Flags.MouseInput,
            (isEnabled: boolean) => {
                this._webRtcController.setMouseInputEnabled(isEnabled);
            }
        );

        this.config._addOnSettingChangedListener(
            Flags.TouchInput,
            (isEnabled: boolean) => {
                this._webRtcController.setTouchInputEnabled(isEnabled);
            }
        );

        this.config._addOnSettingChangedListener(
            Flags.GamepadInput,
            (isEnabled: boolean) => {
                this._webRtcController.setGamePadInputEnabled(isEnabled);
            }
        );

        // encoder settings
        this.config._addOnNumericSettingChangedListener(
            NumericParameters.MinQP,
            (newValue: number) => {
                Logger.Log(
                    Logger.GetStackTrace(),
                    '--------  Sending MinQP  --------',
                    7
                );
                this._webRtcController.sendEncoderMinQP(newValue);
                Logger.Log(
                    Logger.GetStackTrace(),
                    '-------------------------------------------',
                    7
                );
            }
        );

        this.config._addOnNumericSettingChangedListener(
            NumericParameters.MaxQP,
            (newValue: number) => {
                Logger.Log(
                    Logger.GetStackTrace(),
                    '--------  Sending encoder settings  --------',
                    7
                );
                this._webRtcController.sendEncoderMaxQP(newValue);
                Logger.Log(
                    Logger.GetStackTrace(),
                    '-------------------------------------------',
                    7
                );
            }
        );

        // WebRTC settings
        this.config._addOnNumericSettingChangedListener(
            NumericParameters.WebRTCMinBitrate,
            (newValue: number) => {
                Logger.Log(
                    Logger.GetStackTrace(),
                    '--------  Sending web rtc settings  --------',
                    7
                );
                this._webRtcController.sendWebRTCMinBitrate(newValue * 1000 /* kbps to bps */);
                Logger.Log(
                    Logger.GetStackTrace(),
                    '-------------------------------------------',
                    7
                );
            }
        );

        this.config._addOnNumericSettingChangedListener(
            NumericParameters.WebRTCMaxBitrate,
            (newValue: number) => {
                Logger.Log(
                    Logger.GetStackTrace(),
                    '--------  Sending web rtc settings  --------',
                    7
                );
                this._webRtcController.sendWebRTCMaxBitrate(newValue * 1000 /* kbps to bps */);
                Logger.Log(
                    Logger.GetStackTrace(),
                    '-------------------------------------------',
                    7
                );
            }
        );

        this.config._addOnNumericSettingChangedListener(
            NumericParameters.WebRTCFPS,
            (newValue: number) => {
                Logger.Log(
                    Logger.GetStackTrace(),
                    '--------  Sending web rtc settings  --------',
                    7
                );
                this._webRtcController.sendWebRTCFps(newValue);
                Logger.Log(
                    Logger.GetStackTrace(),
                    '-------------------------------------------',
                    7
                );
            }
        );

        this.config._addOnOptionSettingChangedListener(
            OptionParameters.PreferredCodec,
            (newValue: string) => {
                if (this._webRtcController) {
                    this._webRtcController.setPreferredCodec(newValue);
                }
            }
        );

        this.config._registerOnChangeEvents(this._eventEmitter);
    }

    /**
     * Activate the on screen keyboard when receiving the command from the streamer
     * @param command - the keyboard command
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _activateOnScreenKeyboard(command: any): void {
        throw new Error('Method not implemented.');
    }

    /**
     * Set the input control ownership
     * @param inputControlOwnership - does the user have input control ownership
     */
    _onInputControlOwnership(inputControlOwnership: boolean): void {
        this._inputController = inputControlOwnership;
    }

    /**
     * Instantiate the WebRTCPlayerController interface to provide WebRTCPlayerController functionality within this class and set up anything that requires it
     * @param webRtcPlayerController - a WebRtcPlayerController controller instance
     */
    private setWebRtcPlayerController(
        webRtcPlayerController: WebRtcPlayerController
    ) {
        this._webRtcController = webRtcPlayerController;

        this._webRtcController.setPreferredCodec(
            this.config.getSettingOption(OptionParameters.PreferredCodec)
                .selected
        );
        this._webRtcController.resizePlayerStyle();

        // connect if auto connect flag is enabled
        this.checkForAutoConnect();
    }

    /**
     * Connect to signaling server.
     */
    public connect() {
        this._eventEmitter.dispatchEvent(new StreamPreConnectEvent());
        this._webRtcController.connectToSignallingServer();
    }

    /**
     * Reconnects to the signaling server. If connection is up, disconnects first
     * before establishing a new connection
     */
    public reconnect() {
        this._eventEmitter.dispatchEvent(new StreamReconnectEvent());
        this._webRtcController.tryReconnect("Reconnecting...");
    }

    /**
     * Disconnect from the signaling server and close open peer connections.
     */
    public disconnect() {
        this._eventEmitter.dispatchEvent(new StreamPreDisconnectEvent());
        this._webRtcController.close();
    }

    /**
     * Play the stream. Can be called only after a peer connection has been established.
     */
    public play() {
        this._onStreamLoading();
        this._webRtcController.playStream();
    }

    /**
     * Auto connect if AutoConnect flag is enabled
     */
    private checkForAutoConnect() {
        // set up if the auto play will be used or regular click to start
        if (this.config.isFlagEnabled(Flags.AutoConnect)) {
            // if autoplaying show an info overlay while while waiting for the connection to begin
            this._onWebRtcAutoConnect();
            this._webRtcController.connectToSignallingServer();
        }
    }

    /** 
     * Will unmute the microphone track which is sent to Unreal Engine.
     * By default, will only unmute an existing mic track.
     * 
     * @param forceEnable Can be used for cases when this object wasn't initialized with a mic track.
     * If this parameter is true, the connection will be restarted with a microphone.
     * Warning: this takes some time, as a full renegotiation and reconnection will happen.
     */
    public unmuteMicrophone(forceEnable = false) : void {
        // If there's an existing mic track, we just set muted state
        if (this.config.isFlagEnabled('UseMic')) {
            this.setMicrophoneMuted(false);
            return;
        }
        
        // If there's no pre-existing mic track, and caller is ok with full reset, we enable and reset
        if (forceEnable) {
            this.config.setFlagEnabled("UseMic", true);
            this.reconnect();
            return;
        }
          
        // If we prefer not to force a reconnection, just warn the user that this operation didn't happen
        Logger.Warning(
            Logger.GetStackTrace(),
            'Trying to unmute mic, but PixelStreaming was initialized with no microphone track. Call with forceEnable == true to re-connect with a mic track.'
        );
    }

    public muteMicrophone() : void {
        if (this.config.isFlagEnabled('UseMic')) {
            this.setMicrophoneMuted(true);
            return;
        }

        // If there wasn't a mic track, just let user know there's nothing to mute
        Logger.Info(
            Logger.GetStackTrace(),
            'Trying to mute mic, but PixelStreaming has no microphone track, so sending sound is already disabled.'
        );
    }

    private setMicrophoneMuted(mute: boolean) : void
    {
        for (const transceiver of this._webRtcController?.peerConnectionController?.peerConnection?.getTransceivers() ?? []) {
            if (RTCUtils.canTransceiverSendAudio(transceiver)) {
                transceiver.sender.track.enabled = !mute;
            }
        }
    }

    /**
     * Emit an event on auto connecting
     */
    _onWebRtcAutoConnect() {
        this._eventEmitter.dispatchEvent(new WebRtcAutoConnectEvent());
    }

    /**
     * Set up functionality to happen when receiving a webRTC answer
     */
    _onWebRtcSdp() {
        this._eventEmitter.dispatchEvent(new WebRtcSdpEvent());
    }

    /**
     * Emits a StreamLoading event
     */
    _onStreamLoading() {
        this._eventEmitter.dispatchEvent(new StreamLoadingEvent());
    }

    /**
     * Event fired when the video is disconnected - emits given eventString or an override
     * message from webRtcController if one has been set
     * @param eventString - a string describing why the connection closed
     * @param allowClickToReconnect - true if we want to allow the user to retry the connection with a click
     */
    _onDisconnect(eventString: string, allowClickToReconnect: boolean) {
        this._eventEmitter.dispatchEvent(
            new WebRtcDisconnectedEvent({
                eventString: eventString,
                allowClickToReconnect: allowClickToReconnect
            })
        );
    }

    /**
     * Handles when Web Rtc is connecting
     */
    _onWebRtcConnecting() {
        this._eventEmitter.dispatchEvent(new WebRtcConnectingEvent());
    }

    /**
     * Handles when Web Rtc has connected
     */
    _onWebRtcConnected() {
        this._eventEmitter.dispatchEvent(new WebRtcConnectedEvent());
    }

    /**
     * Handles when Web Rtc fails to connect
     */
    _onWebRtcFailed() {
        this._eventEmitter.dispatchEvent(new WebRtcFailedEvent());
    }


    _updateVideoTexture() {
        const video = this._webRtcController.videoPlayer.getVideoElement(); 
        const videoHeight = video.videoHeight;
        const videoWidth = video.videoWidth;
    
        // Always create a new texture when the video dimensions change
        if(this._prevVideoHeight != videoHeight || this._prevVideoWidth != videoWidth){
            // Delete the old texture if it exists
            if (this._videoTexture) {
                this._gl.deleteTexture(this._videoTexture);
                this._videoTexture = null;
            }
    
            // Create a new texture
            this._videoTexture = this._gl.createTexture();
            this._gl.bindTexture(this._gl.TEXTURE_2D, this._videoTexture);
    
            // Set the parameters so we can render any size image.
            this._gl.texParameteri(
                this._gl.TEXTURE_2D,
                this._gl.TEXTURE_WRAP_S,
                this._gl.CLAMP_TO_EDGE
            );
            this._gl.texParameteri(
                this._gl.TEXTURE_2D,
                this._gl.TEXTURE_WRAP_T,
                this._gl.CLAMP_TO_EDGE
            );
            this._gl.texParameteri(
                this._gl.TEXTURE_2D,
                this._gl.TEXTURE_MIN_FILTER,
                this._gl.LINEAR
            );
            this._gl.texParameteri(
                this._gl.TEXTURE_2D,
                this._gl.TEXTURE_MAG_FILTER,
                this._gl.LINEAR
            );
    
            // Do full update of texture with new dimensions
            this._gl.texImage2D(
                this._gl.TEXTURE_2D,
                0,
                this._gl.RGBA,
                videoWidth,
                videoHeight,
                0,
                this._gl.RGBA,
                this._gl.UNSIGNED_BYTE,
                video
            );
    
            // Update prev video width/height
            this._prevVideoHeight = videoHeight;
            this._prevVideoWidth = videoWidth;
        } else {
            // If dimensions match just update the sub region
            this._gl.texSubImage2D(
                this._gl.TEXTURE_2D,
                0,
                0,
                0,
                videoWidth,
                videoHeight,
                this._gl.RGBA,
                this._gl.UNSIGNED_BYTE,
                video
            );
        }
    }
    


    _initGL() {
        
        const video = this._webRtcController.videoPlayer.getVideoElement();

        this._canvas = document.createElement('canvas');
        this._canvas.id = 'customCanvas';
        this._canvas.style.width = '100%';
        this._canvas.style.height = '100%';
        this._canvas.style.position = 'absolute';
        this._canvas.style.pointerEvents = 'all';

        this._canvas.width = video.videoWidth;
        this._canvas.height = video.videoHeight;
        this._gl = this._canvas.getContext('webgl2', {
            xrCompatible: true
        });
        this._gl.clearColor(0.0, 0.0, 0.0, 1);
  
        video.parentElement.appendChild(this._canvas);

        // WebGL’s default behavior is to clear the alpha channel to 1.0 (fully opaque). 
        // If you want to see through the parts of the canvas where you’ve discarded fragments,
        this._gl.enable(this._gl.BLEND);
        // If depth testing is enabled, the pixel stream might be occluded by the XRWebGLLayer even if it’s rendered afterwards
        this._gl.disable(this._gl.DEPTH_TEST);
        this._gl.blendFunc(this._gl.SRC_ALPHA, this._gl.ONE_MINUS_SRC_ALPHA);
    }

    /**
     * Handle when the Video has been Initialized
     */
    _onVideoInitialized() {
        this._eventEmitter.dispatchEvent(new VideoInitializedEvent());
        this._videoStartTime = Date.now();

        this._initGL();
        this._initShaders();
        this._initBuffers();

        // Create our texture that we use in our shader
        // and bind it once because we never use any other texture.
        this._videoTexture = this._gl.createTexture();
        this._gl.bindTexture(this._gl.TEXTURE_2D, this._videoTexture);

        // Set the parameters so we can render any size image.
        this._gl.texParameteri(
            this._gl.TEXTURE_2D,
            this._gl.TEXTURE_WRAP_S,
            this._gl.CLAMP_TO_EDGE
        );
        this._gl.texParameteri(
            this._gl.TEXTURE_2D,
            this._gl.TEXTURE_WRAP_T,
            this._gl.CLAMP_TO_EDGE
        );
        this._gl.texParameteri(
            this._gl.TEXTURE_2D,
            this._gl.TEXTURE_MIN_FILTER,
            this._gl.LINEAR
        );
        this._gl.texParameteri(
            this._gl.TEXTURE_2D,
            this._gl.TEXTURE_MAG_FILTER,
            this._gl.LINEAR
        );
    }
    
    _initShaders() {

        // shader source code
        const vertexShaderSource: string =
        `
        attribute vec2 a_position;
        attribute vec2 a_texCoord;

        // varyings
        varying vec2 v_texCoord;

        void main() {
           gl_Position = vec4(a_position.x, a_position.y, 0, 1);
           // pass the texCoord to the fragment shader
           // The GPU will interpolate this value between points.
           v_texCoord = a_texCoord;
        }
        `;

        const fragmentShaderSource: string =
        `
        precision mediump float;

        // our texture
        uniform sampler2D u_image;

        // the texCoords passed in from the vertex shader.
        varying vec2 v_texCoord;

        void main() {
            // gl_FragColor = texture2D(u_image, v_texCoord);
            vec4 color = texture2D(u_image, v_texCoord);
            // checking if the green component of the color is significantly higher than the red and blue components
            if (color.g > 0.6 && color.r < 0.4 && color.b < 0.4) {
                discard;
            } else {
                gl_FragColor = color;
            }

        }
        `;

        // setup vertex shader
        const vertexShader = this._gl.createShader(this._gl.VERTEX_SHADER);
        this._gl.shaderSource(vertexShader, vertexShaderSource);
        this._gl.compileShader(vertexShader);
        if (!this._gl.getShaderParameter(vertexShader, this._gl.COMPILE_STATUS)) {
            console.error('ERROR compiling vertex shader!', this._gl.getShaderInfoLog(vertexShader));
            return;
        }

        // setup fragment shader
        const fragmentShader = this._gl.createShader(this._gl.FRAGMENT_SHADER);
        this._gl.shaderSource(fragmentShader, fragmentShaderSource);
        this._gl.compileShader(fragmentShader);
        if (!this._gl.getShaderParameter(fragmentShader, this._gl.COMPILE_STATUS)) {
            console.error('ERROR compiling fragment shader!', this._gl.getShaderInfoLog(fragmentShader));
            return;
        }

        // setup GLSL program
        const shaderProgram = this._gl.createProgram();
        this._gl.attachShader(shaderProgram, vertexShader);
        this._gl.attachShader(shaderProgram, fragmentShader);
        this._gl.linkProgram(shaderProgram);
        if (!this._gl.getProgramParameter(shaderProgram, this._gl.LINK_STATUS)) {
            console.error('ERROR linking program!', this._gl.getProgramInfoLog(shaderProgram));
            return;
        }

        this._gl.useProgram(shaderProgram);

        // look up where vertex data needs to go
        this._positionLocation = this._gl.getAttribLocation(
            shaderProgram,
            'a_position'
        );
        this._texcoordLocation = this._gl.getAttribLocation(
            shaderProgram,
            'a_texCoord'
        );
    }


    _initBuffers(){
        // Create out position buffer and its vertex shader attribute
        {
            // Create a buffer to put the the vertices of the plane we will draw the video stream onto
            this._positionBuffer = this._gl.createBuffer();
            // Bind the position buffer
            this._gl.bindBuffer(this._gl.ARRAY_BUFFER, this._positionBuffer);
            // Enable `positionLocation` to be used as vertex shader attribute
            this._gl.enableVertexAttribArray(this._positionLocation);

            // Note: positions are passed in clip-space coordinates [-1..1] so no need to convert in-shader
            // prettier-ignore
            this._gl.bufferData(
                this._gl.ARRAY_BUFFER,
                new Float32Array([
                    -1.0,  1.0,
                     1.0,  1.0,
                    -1.0, -1.0,
                    -1.0, -1.0,
                     1.0,  1.0,
                     1.0, -1.0
                ]),
                this._gl.STATIC_DRAW
            );

            // Tell position attribute of the vertex shader how to get data out of the bound buffer (the positionBuffer)
            this._gl.vertexAttribPointer(
                this._positionLocation,
                2 /*size*/,
                this._gl.FLOAT /*type*/,
                false /*normalize*/,
                0 /*stride*/,
                0 /*offset*/
            );
        }

        // Create our texture coordinate buffers for accessing our texture
        {
            this._texcoordBuffer = this._gl.createBuffer();
            // Bind the texture coordinate buffer
            this._gl.bindBuffer(this._gl.ARRAY_BUFFER, this._texcoordBuffer);
            // Enable `texcoordLocation` to be used as a vertex shader attribute
            this._gl.enableVertexAttribArray(this._texcoordLocation);

            // The texture coordinates to apply for rectangle we are drawing
            this._gl.bufferData(
                this._gl.ARRAY_BUFFER,
                new Float32Array([
                    0.0, 0.0,
                    1.0, 0.0,
                    0.0, 1.0,
                    0.0, 1.0,
                    1.0, 0.0,
                    1.0, 1.0
                ]),
                this._gl.STATIC_DRAW
            );

            // Tell texture coordinate attribute of the vertex shader how to get data out of the bound buffer (the texcoordBuffer)
            this._gl.vertexAttribPointer(
                this._texcoordLocation,
                2 /*size*/,
                this._gl.FLOAT /*type*/,
                false /*normalize*/,
                0 /*stride*/,
                0 /*offset*/
            );
        }
    }
    
    _onFrame(time: DOMHighResTimeStamp, frame: XRFrame) {

        Logger.Log(Logger.GetStackTrace(), 'PixelStream: _onFrame');
        this._updateVideoTexture();

        const video = this._webRtcController.videoPlayer.getVideoElement();           
        

        // Bind the framebuffer to the base layer's framebuffer
        const glLayer = this.customArController.xrSession.renderState.baseLayer;
        this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, glLayer.framebuffer);

        // const videoHeight = video.videoHeight;
        // const videoWidth = video.videoWidth;
        // this._gl.viewport(0, 0, this._canvas.width, this._canvas.height);
        // this._gl.drawArrays(this._gl.TRIANGLES, 0, 6);

        // Set the relevant portion of clip space
        this._gl.viewport(0, 0, glLayer.framebufferWidth, glLayer.framebufferHeight);

        // Draw the rectangle we will show the video stream texture on
        this._gl.drawArrays(this._gl.TRIANGLES /*primitiveType*/, 0 /*offset*/, 6 /*count*/);
    }

    /**
     * Set up functionality to happen when receiving latency test results
     * @param latency - latency test results object
     */
    _onLatencyTestResult(latencyTimings: LatencyTestResults) {
        this._eventEmitter.dispatchEvent(
            new LatencyTestResultEvent({ latencyTimings })
        );
    }

    _onDataChannelLatencyTestResponse(response: DataChannelLatencyTestResponse) {
        this._eventEmitter.dispatchEvent(
            new DataChannelLatencyTestResponseEvent({ response })
        );
    }

    /**
     * Set up functionality to happen when receiving video statistics
     * @param videoStats - video statistics as a aggregate stats object
     */
    _onVideoStats(videoStats: AggregatedStats) {
        // Duration
        if (!this._videoStartTime || this._videoStartTime === undefined) {
            this._videoStartTime = Date.now();
        }
        videoStats.handleSessionStatistics(
            this._videoStartTime,
            this._inputController,
            this._webRtcController.videoAvgQp
        );

        this._eventEmitter.dispatchEvent(
            new StatsReceivedEvent({ aggregatedStats: videoStats })
        );
    }

    /**
     * Set up functionality to happen when calculating the average video encoder qp
     * @param QP - the quality number of the stream
     */
    _onVideoEncoderAvgQP(QP: number) {
        this._eventEmitter.dispatchEvent(
            new VideoEncoderAvgQPEvent({ avgQP: QP })
        );
    }

    /**
     * Set up functionality to happen when receiving and handling initial settings for the UE app
     * @param settings - initial UE app settings
     */
    _onInitialSettings(settings: InitialSettings) {
        this._eventEmitter.dispatchEvent(
            new InitialSettingsEvent({ settings })
        );
        if (settings.PixelStreamingSettings) {
            this.allowConsoleCommands =
                settings.PixelStreamingSettings.AllowPixelStreamingCommands ?? false;
            if (this.allowConsoleCommands === false) {
                Logger.Info(
                    Logger.GetStackTrace(),
                    '-AllowPixelStreamingCommands=false, sending arbitrary console commands from browser to UE is disabled.'
                );
            }
        }

        const useUrlParams = this.config.useUrlParams;
        const urlParams = new IURLSearchParams(window.location.search);
        Logger.Info(
            Logger.GetStackTrace(),
            `using URL parameters ${useUrlParams}`
        );
        if (settings.EncoderSettings) {
            this.config.setNumericSetting(
                NumericParameters.MinQP,
                // If a setting is set in the URL, make sure we respect that value as opposed to what the application sends us
                (useUrlParams && urlParams.has(NumericParameters.MinQP)) 
                    ? Number.parseFloat(urlParams.get(NumericParameters.MinQP)) 
                    : settings.EncoderSettings.MinQP
            );

            
            this.config.setNumericSetting(
                NumericParameters.MaxQP,
                (useUrlParams && urlParams.has(NumericParameters.MaxQP)) 
                    ? Number.parseFloat(urlParams.get(NumericParameters.MaxQP)) 
                    : settings.EncoderSettings.MaxQP
            );
        }
        if (settings.WebRTCSettings) {
            this.config.setNumericSetting(
                NumericParameters.WebRTCMinBitrate,
                (useUrlParams && urlParams.has(NumericParameters.WebRTCMinBitrate)) 
                    ? Number.parseFloat(urlParams.get(NumericParameters.WebRTCMinBitrate))
                    : (settings.WebRTCSettings.MinBitrate / 1000) /* bps to kbps */
            );
            this.config.setNumericSetting(
                NumericParameters.WebRTCMaxBitrate,
                (useUrlParams && urlParams.has(NumericParameters.WebRTCMaxBitrate)) 
                    ? Number.parseFloat(urlParams.get(NumericParameters.WebRTCMaxBitrate))
                    : (settings.WebRTCSettings.MaxBitrate / 1000) /* bps to kbps */
                
            );
            this.config.setNumericSetting(
                NumericParameters.WebRTCFPS,
                (useUrlParams && urlParams.has(NumericParameters.WebRTCFPS)) 
                    ? Number.parseFloat(urlParams.get(NumericParameters.WebRTCFPS))
                    : settings.WebRTCSettings.FPS
            );
        }
    }

    /**
     * Set up functionality to happen when setting quality control ownership of a stream
     * @param hasQualityOwnership - does this user have quality ownership of the stream true / false
     */
    _onQualityControlOwnership(hasQualityOwnership: boolean) {
        this.config.setFlagEnabled(
            Flags.IsQualityController,
            hasQualityOwnership
        );
    }

    _onPlayerCount(playerCount: number) {
        this._eventEmitter.dispatchEvent(
            new PlayerCountEvent({ count: playerCount })
        );
    }

    // Sets up to emit the webrtc tcp relay detect event 
    _setupWebRtcTCPRelayDetection(statsReceivedEvent: StatsReceivedEvent) {
        // Get the active candidate pair
        const activeCandidatePair = statsReceivedEvent.data.aggregatedStats.getActiveCandidatePair();
                
        // Check if the active candidate pair is not null
        if (activeCandidatePair != null) {

            // Get the local candidate assigned to the active candidate pair
            const localCandidate = statsReceivedEvent.data.aggregatedStats.localCandidates.find((candidate) => candidate.id == activeCandidatePair.localCandidateId, null)

            // Check if the local candidate is not null, candidate type is relay and the relay protocol is tcp
            if (localCandidate != null && localCandidate.candidateType == 'relay' && localCandidate.relayProtocol == 'tcp') {

                // Send the web rtc tcp relay detected event
                this._eventEmitter.dispatchEvent(new WebRtcTCPRelayDetectedEvent());
            }
            // The check is completed and the stats listen event can be removed
            this._eventEmitter.removeEventListener("statsReceived", this._setupWebRtcTCPRelayDetection);
        }
    }

    /**
     * Request a connection latency test.
     * NOTE: There are plans to refactor all request* functions. Expect changes if you use this!
     * @returns
     */
    public requestLatencyTest() {
        if (!this._webRtcController.videoPlayer.isVideoReady()) {
            return false;
        }
        this._webRtcController.sendLatencyTest();
        return true;
    }

    /**
     * Request a data channel latency test.
     * NOTE: There are plans to refactor all request* functions. Expect changes if you use this!
     */
    public requestDataChannelLatencyTest(config: DataChannelLatencyTestConfig) {
        if (!this._webRtcController.videoPlayer.isVideoReady()) {
            return false;
        }
        if (!this._dataChannelLatencyTestController) {
            this._dataChannelLatencyTestController = new DataChannelLatencyTestController(
                this._webRtcController.sendDataChannelLatencyTest.bind(this._webRtcController),
                (result: DataChannelLatencyTestResult) => {
                    this._eventEmitter.dispatchEvent(new DataChannelLatencyTestResultEvent( { result }))
                });
            this.addEventListener(
                "dataChannelLatencyTestResponse",
                ({data: {response} }) => {
                    this._dataChannelLatencyTestController.receive(response);
                }
            )
        }
        return this._dataChannelLatencyTestController.start(config);
    }

    /**
     * Request for the UE application to show FPS counter.
     * NOTE: There are plans to refactor all request* functions. Expect changes if you use this!
     * @returns
     */
    public requestShowFps() {
        if (!this._webRtcController.videoPlayer.isVideoReady()) {
            return false;
        }
        this._webRtcController.sendShowFps();
        return true;
    }

    /**
     * Request for a new IFrame from the UE application.
     * NOTE: There are plans to refactor all request* functions. Expect changes if you use this!
     * @returns
     */
    public requestIframe() {
        if (!this._webRtcController.videoPlayer.isVideoReady()) {
            return false;
        }
        this._webRtcController.sendIframeRequest();
        return true;
    }

    /**
     * Send data to UE application. The data will be run through JSON.stringify() so e.g. strings
     * and any serializable plain JSON objects with no recurrence can be sent.
     * @returns true if succeeded, false if rejected
     */
    public emitUIInteraction(descriptor: object | string) {
        if (!this._webRtcController.videoPlayer.isVideoReady()) {
            return false;
        }
        this._webRtcController.emitUIInteraction(descriptor);
        return true;
    }

    /**
     * Send a command to UE application. Blocks ConsoleCommand descriptors unless UE
     * has signaled that it allows console commands.
     * @returns true if succeeded, false if rejected
     */
    public emitCommand(descriptor: object) {
        if (!this._webRtcController.videoPlayer.isVideoReady()) {
            return false;
        }
        if (!this.allowConsoleCommands && 'ConsoleCommand' in descriptor) {
            return false;
        }
        this._webRtcController.emitCommand(descriptor);
        return true;
    }

    /**
     * Send a console command to UE application. Only allowed if UE has signaled that it allows
     * console commands.
     * @returns true if succeeded, false if rejected
     */
    public emitConsoleCommand(command: string) {
        if (!this.allowConsoleCommands || !this._webRtcController.videoPlayer.isVideoReady()) {
            return false;
        }
        this._webRtcController.emitConsoleCommand(command);
        return true;
    }

    /**
     * Add a UE -> browser response event listener
     * @param name - The name of the response handler
     * @param listener - The method to be activated when a message is received
     */
    public addResponseEventListener(
        name: string,
        listener: (response: string) => void
    ) {
        this._webRtcController.responseController.addResponseEventListener(name, listener);
    }

    /**
     * Remove a UE -> browser response event listener
     * @param name - The name of the response handler
     */
    public removeResponseEventListener(name: string) {
        this._webRtcController.responseController.removeResponseEventListener(name);
    }

    /**
     * Dispatch a new event.
     * @param e event
     * @returns
     */
    public dispatchEvent(e: PixelStreamingEvent): boolean {
        return this._eventEmitter.dispatchEvent(e);
    }
    
    /**
     * Register an event handler.
     * @param type event name
     * @param listener event handler function
     */
    public addEventListener<
        T extends PixelStreamingEvent['type'],
        E extends PixelStreamingEvent & { type: T }
    >(type: T, listener: (e: Event & E) => void) {
        this._eventEmitter.addEventListener(type, listener);
    }

    /**
     * Remove an event handler.
     * @param type event name
     * @param listener event handler function
     */
    public removeEventListener<
        T extends PixelStreamingEvent['type'],
        E extends PixelStreamingEvent & { type: T }
    >(type: T, listener: (e: Event & E) => void) {
        this._eventEmitter.removeEventListener(type, listener);
    }

    /**
     * Enable/disable XR mode.
     */
    public toggleXR() {
        // XR session need to be started from a user interaction for security reason otherwise features won't work
        this.customArController.onFrame.addEventListener('xrFrame', this._onFrame.bind(this))
        this.customArController.startSession(this._gl);
    }

    /**
     * Pass in a function to generate a signalling server URL.
     * This function is useful if you need to programmatically construct your signalling server URL.
     * @param signallingUrlBuilderFunc A function that generates a signalling server url.
     */
    public setSignallingUrlBuilder(signallingUrlBuilderFunc: ()=>string) {
        this._webRtcController.signallingUrlBuilder = signallingUrlBuilderFunc;
    }

    /**
     * Public getter for the websocket controller. Access to this property allows you to send
     * custom websocket messages.
     */
    public get signallingProtocol() {
        return this._webRtcController.protocol;
    }

    /**
     * Public getter for the arController controller. Used for all XR features.
     */
    public get customArController() {
        return this._customArController;
    }

    /**
     * Public getter for the webXrController controller. Used for all XR features.
     */
    public get webXrController() {
        return this._webXrController;
    }

    public registerMessageHandler(name: string, direction: MessageDirection, handler?: (data: ArrayBuffer | Array<number | string>) => void) {
        if(direction === MessageDirection.FromStreamer && typeof handler === 'undefined') {
            Logger.Warning(Logger.GetStackTrace(), `Unable to register an undefined handler for ${name}`)
            return;
        }

        if(direction === MessageDirection.ToStreamer && typeof handler === 'undefined') {
            this._webRtcController.streamMessageController.registerMessageHandler(
                direction,
                name,
                (data: Array<number | string>) =>
                this._webRtcController.sendMessageController.sendMessageToStreamer(
                    name,
                    data
                )
            );
        } else {
            this._webRtcController.streamMessageController.registerMessageHandler(
                direction,
                name,
                (data: ArrayBuffer) => handler(data)
            );
        }
    }

    public get toStreamerHandlers() {
        return this._webRtcController.streamMessageController.toStreamerHandlers;
    }

    public isReconnecting() {
        return this._webRtcController.isReconnecting;
    }
}
