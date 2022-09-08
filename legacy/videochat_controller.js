import { Controller } from "stimulus";
import TwilioVideo from "twilio-video";
import { createConsumer } from "@rails/actioncable";
import DemoProvider from "./videochat/demo_provider";

const { _, I18n, Rollbar } = window;

const PROVIDERS = {
  twilio: () => TwilioVideo,
  demo: (controller) =>
    new DemoProvider(
      controller.participantTargets.map((el) => el.dataset.identity),
      controller.data.get("local-identity")
    ),
};

const ROOM_NOT_CREATABLE_ERROR = 53103;
const ROOM_NOT_FOUND_ERROR = 53106;
const ROOM_COMPLETED_ERROR = 53118;
const PARTICIPANTS_STATES = [
  "pending",
  "accepted",
  "connected",
  "disconnected",
  "canceled",
];

const BAD_SIGNAL_THRESHOLD = 3;

export default class extends Controller {
  static targets = [
    "window",
    "main",
    "auxiliary",
    "error",
    "recordingButton",
    "participant",
    "unsupportedBrowser",
    "unsupportedIOSBrowser",
    "participantList",
  ];

  initialize() {
    window.addEventListener("beforeunload", (event) => {
      if (this.isConnected()) {
        event.preventDefault();
        // eslint-disable-next-line no-param-reassign
        event.returnValue = "";
      }
    });

    window.addEventListener("unload", this.pageHide.bind(this));
    // iOS Safari does not emit the "beforeunload" event on window. Use "pagehide" instead.
    window.addEventListener("pagehide", this.pageHide.bind(this));

    this.provider = PROVIDERS[this.data.get("provider")](this);
  }

  pageHide() {
    if (this.isConnected()) {
      navigator.sendBeacon(
        `${this.data.get("url")}/disconnect?ptoken=${this.data.get("token")}`
      );
      this.room.disconnect();
    }
  }

  set error(error) {
    if (error) {
      this.errorMessage = I18n.t(`twilio_error_${error.code}`) || error.message;
    } else {
      this.errorMessage = null;
    }
    if (this.errorMessage) {
      this.errorTarget.textContent = this.errorMessage;
    }
    this.updateStateClasses();
  }

  isConnected() {
    return this.room != null;
  }

  reset() {
    this.room = null;
    this.recording = false;
    this.connecting = false;
    this.mainIdentity = null;
    this.badSignal = false;
    this.hideBadSignalWarning = false;
    this.selectedIdentities = [];
  }

  connect() {
    if (this.provider.isSupported) {
      this.participants = JSON.parse(this.data.get("participants"));
      this.muted = false;
      this.paused = false;
      this.reset();

      this.setupWindow();
      this.setupChannel();
    } else {
      this.windowTarget.style.display = "none";
      this.unsupportedBrowserTarget.style.display = "block";
    }
  }

  setupWindow() {
    if (!this.hasWindowTarget) return;

    this.updateUI();

    // Not all browsers (notably Safari on iPhone) support fullscreen API, so hide it for those browsers.
    if (this.windowTarget.requestFullscreen) {
      this.windowTarget.classList.add("videochat-fullscreen-support");
    }

    this.createPreview().catch((err) => {
      // adapted from https://blog.addpipe.com/common-getusermedia-errors/
      if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        this.error = { message: I18n.t("videochat_error_not_found") };
      } else if (
        err.name === "NotReadableError" ||
        err.name === "TrackStartError"
      ) {
        this.error = { message: I18n.t("videochat_error_in_use") };
      } else if (
        err.name === "NotAllowedError" ||
        err.name === "PermissionDeniedError"
      ) {
        this.error = {
          message: I18n.t("videochat_error_permission_denied"),
        };
      } else {
        Rollbar?.error(err);
        this.error = err;
      }
    });
  }

  setupChannel() {
    this.consumer = createConsumer(
      `/cable?token=${this.data.get("consumer-sgid")}`
    );
    this.channel = this.consumer.subscriptions.create(
      {
        channel: "VideochatChannel",
        token: this.data.get("token"),
      },
      {
        received: (event) => {
          if (event.type === "update_participant") {
            this.updateParticipant(event.data);
          } else if (event.type === "update_recording") {
            this.updateRecordingStatus(event.status === "running");
          }
        },
      }
    );
  }

  updateParticipant(participantData) {
    const participant = this.findParticipant(participantData.identity);

    // The participant was added after the videochat UI was already loaded.
    if (participant === undefined) {
      this.loadUnknownParticipant(participantData);
      return;
    }

    participant.state = participantData.state;
    participant.muted = participantData.muted;
    participant.paused = participantData.paused;
    participant.currently_viewing = participantData.currently_viewing;
    participant.audio_recording = participantData.audio_recording;
    participant.video_recording = participantData.video_recording;

    this.updateParticipantTarget(participant);
  }

  loadUnknownParticipant(participant) {
    $.rails.ajax({
      url: `${this.data.get("url")}/participants/${participant.id}`,
      data: { ptoken: this.data.get("token") },
      success: () => {
        // We have to wait until success to run updateParticipant to ensure that loadParticipantTarget exists.
        this.participants.push(participant);
        this.updateParticipant(participant);
      },
    });
  }

  updateParticipantTargets() {
    this.participants.forEach(this.updateParticipantTarget.bind(this));
  }

  updateParticipantTarget(participant) {
    const participantTarget = this.getParticipantTarget(participant);

    if (!this.isParticipantConnected(participant)) {
      this.clearParticipantTarget(participant);
      return;
    }

    // Set participant state
    PARTICIPANTS_STATES.forEach((state) =>
      participantTarget.classList.toggle(
        `videochat-participant-${state}`,
        participant.state === state
      )
    );
    participantTarget.classList.toggle(
      "videochat-participant-connected",
      this.isParticipantConnected(participant)
    );

    // Set states for muted / paused
    participantTarget.classList.toggle(
      "videochat-participant-mute",
      participant.muted
    );
    participantTarget.classList.toggle(
      "videochat-participant-unmute",
      !participant.muted
    );
    participantTarget.classList.toggle(
      "videochat-participant-pause",
      participant.paused
    );
    participantTarget.classList.toggle(
      "videochat-participant-unpause",
      !participant.paused
    );
    if (participant.networkQualityLevel) {
      participantTarget.classList.toggle(
        "videochat-participant-bad-signal",
        participant.networkQualityLevel < BAD_SIGNAL_THRESHOLD
      );
    } else {
      participantTarget.classList.remove("videochat-participant-bad-signal");
    }

    // Set states for recording
    participantTarget.classList.toggle(
      "videochat-participant-audio-recording",
      participant.audio_recording
    );
    participantTarget.classList.toggle(
      "videochat-participant-video-recording",
      participant.video_recording
    );
    participantTarget.classList.toggle("is-recording", this.recording);

    // Set states for selection status
    participantTarget.classList.toggle(
      "is-selected",
      this.selectedIdentities.indexOf(participant.identity) !== -1
    );
    participantTarget.classList.toggle(
      "is-dominant",
      this.mainIdentity === participant.identity
    );

    // Update currently-viewing
    const currentlyViewingTarget = participantTarget.querySelector(
      ".videochat-participant--currently-viewing > span"
    );
    if (participant.currently_viewing.length > 0) {
      const participantList = participant.currently_viewing.map((identity) =>
        this.findParticipant(identity)
      );

      currentlyViewingTarget.textContent = participantList
        .map((otherParticipant) => otherParticipant.familiar_name)
        .join(", ");

      const nameList = participantList.map(
        (otherParticipant) => otherParticipant.familiar_name
      );

      currentlyViewingTarget.title = [
        currentlyViewingTarget.dataset.prefix,
        nameList.join(", "),
      ].join(" ");
    } else {
      currentlyViewingTarget.textContent = "";
      currentlyViewingTarget.title = "";
    }
  }

  clearParticipantTarget(participant) {
    const participantTarget = this.getParticipantTarget(participant);

    PARTICIPANTS_STATES.forEach((state) =>
      participantTarget.classList.remove(`videochat-participant-${state}`)
    );

    participantTarget.classList.remove(
      "videochat-participant-mute",
      "videochat-participant-unmute",
      "videochat-participant-pause",
      "videochat-participant-unpause",
      "videochat-participant-audio-recording",
      "videochat-participant-video-recording",
      "videochat-participant-bad-signal",
      "is-recording",
      "is-selected",
      "is-dominant"
    );

    const currentlyViewingTarget = participantTarget.querySelector(
      ".videochat-participant--currently-viewing > span"
    );
    currentlyViewingTarget.textContent = "";
  }

  updateRecordingStatus(newRecordingStatus) {
    if (this.recording !== newRecordingStatus) {
      this.recording = newRecordingStatus;
      this.updateStateClasses();
      this.updateParticipantTargets();
    }
    if (this.hasRecordingButtonTarget) {
      $.rails.ajax({
        url: `${this.data.get("url")}/recordings`,
        data: { ptoken: this.data.get("token") },
      });
    }
  }

  async createPreview() {
    this.localTracks = await this.provider.createLocalTracks({
      audio: true,
      video: { width: 1280, height: 720 },
    });
    const localVideoTrack = this.localTracks.find(
      (track) => track.kind === "video"
    );

    const localParticipant = {
      identity: this.data.get("local-identity"),
      tracks: [{ isSubscribed: true, track: localVideoTrack }],
      videoTracks: [{ isSubscribed: true, track: localVideoTrack }],
    };
    this.participantConnected(localParticipant);
  }

  connectChat() {
    this.error = null;
    this.connecting = true;
    this.updateStateClasses();

    $.rails.ajax({
      url: `${this.data.get("url")}/connect`,
      format: "json",
      method: "POST",
      data: { ptoken: this.data.get("token") },
      success: (data) => {
        this.recording = data.recording;
        this.enterRoom(data.token);
      },
      error: (jqXHR) => {
        if (jqXHR.responseJSON) {
          this.error = jqXHR.responseJSON.error;
        } else {
          this.error = { message: I18n.t("request_error") };
        }
        this.connecting = false;
        this.updateStateClasses();
      },
    });
  }

  enterRoom(accessToken) {
    this.provider
      .connect(accessToken, {
        tracks: this.localTracks,
        dominantSpeaker: false,
        preferredVideoCodecs: "auto",
        networkQuality: {
          local: 1,
          remote: 1,
        },
        bandwidthProfile: {
          video: {
            mode: "grid",
            trackSwitchOffMode: "predicted",
            contentPreferencesMode: "auto",
            clientTrackSwitchOffControl: "auto",
          },
        },
      })
      .then(
        (room) => {
          this.room = room;

          room.participants.forEach(this.participantConnected.bind(this));
          room.on("participantConnected", this.participantConnected.bind(this));
          room.on(
            "participantDisconnected",
            this.participantDisconnected.bind(this)
          );
          room.once("disconnected", (disconnectedRoom, error) => {
            this.broadcastStatus("disconnected");
            this.cleanup(disconnectedRoom);
            if (error) {
              if (error.code === ROOM_COMPLETED_ERROR) {
                window.location.reload(true);
              } else {
                this.error = error;
              }
            }
          });

          room.localParticipant.on(
            "networkQualityLevelChanged",
            this.localNetworkQualityLevelChanged.bind(this)
          );

          this.broadcastStatus("connected");

          this.updateParticipantTargets();
          this.connecting = false;
          this.updateUI();
        },
        (error) => {
          if (
            error.code === ROOM_NOT_CREATABLE_ERROR ||
            error.code === ROOM_NOT_FOUND_ERROR
          ) {
            // Reload the page if the room was already completed.
            window.location.reload(true);
          } else {
            this.connecting = false;
            this.error = error;
            this.updateUI();
          }
        }
      );
  }

  broadcastStatus(status) {
    this.channel.perform("update_status", { status });
  }

  updateUI() {
    this.updateStateClasses();
    this.updateRecordingButton();
  }

  updateRecordingButton() {
    if (!this.hasRecordingButtonTarget) return;

    this.recordingButtonTarget.disabled = !this.isConnected();
  }

  updateStateClasses() {
    this.windowTarget.classList.remove(
      "videochat-connected",
      "videochat-disconnected",
      "videochat-muted",
      "videochat-unmuted",
      "videochat-paused",
      "videochat-unpaused",
      "videochat-recording",
      "videochat-connecting",
      "videochat-erroring",
      "videochat-shared",
      "videochat-dominant",
      "videochat-bad-signal",
      "videochat-participants-0",
      "videochat-participants-1",
      "videochat-participants-2",
      "videochat-participants-3",
      "videochat-participants-4",
      "videochat-participants-5",
      "videochat-participants-6",
      "videochat-participants-7",
      "videochat-participants-8",
      "videochat-participants-9"
    );

    const stateClasses = [];
    stateClasses.push(
      this.isConnected() ? "videochat-connected" : "videochat-disconnected"
    );
    stateClasses.push(this.muted ? "videochat-muted" : "videochat-unmuted");
    stateClasses.push(this.paused ? "videochat-paused" : "videochat-unpaused");
    stateClasses.push(
      this.mainIdentity ? "videochat-dominant" : "videochat-shared"
    );
    if (this.recording) stateClasses.push("videochat-recording");
    if (this.connecting) stateClasses.push("videochat-connecting");
    if (this.errorMessage) stateClasses.push("videochat-erroring");
    if (this.badSignal && !this.hideBadSignalWarning)
      stateClasses.push("videochat-bad-signal");

    stateClasses.push(
      `videochat-participants-${this.selectedIdentities.length}`
    );

    this.windowTarget.classList.add(...stateClasses);
  }

  findParticipant(identity) {
    return this.participants.find(
      (participant) => participant.identity === identity
    );
  }

  getParticipantTarget(participant) {
    return this.participantTargets.find(
      (target) => target.dataset.identity === participant.identity
    );
  }

  updateParticipantTrackPriority(participant) {
    if (this.isLocalParticipant(participant)) return;
    if (!this.isParticipantConnected(participant)) return;
    if (!participant.remoteParticipant) return;

    const priority = this.getPriorityFor(participant);
    participant.remoteParticipant.videoTracks.forEach((publication) => {
      if (publication.isSubscribed) publication.track.setPriority(priority);
    });
  }

  getPriorityFor(participant) {
    if (this.mainIdentity === participant.identity) {
      return "high";
    }
    if (this.isSelectedParticipant(participant)) {
      return this.selectedIdentities.length === 1 ? "high" : "standard";
    }
    return "low";
  }

  renderParticipants() {
    this.participants.forEach((participant) => {
      this.updateParticipantTrackPriority(participant);
      this.renderParticipant(participant);
    });
  }

  renderParticipant(participant) {
    if (!this.isParticipantConnected(participant)) return;

    const element = participant.div;
    if (!element) return;

    if (this.mainIdentity === participant.identity) {
      if (!this.mainTarget.contains(element)) {
        this.mainTarget.appendChild(element);
      }
    } else if (this.selectedIdentities.includes(participant.identity)) {
      if (!this.auxiliaryTarget.contains(element)) {
        this.auxiliaryTarget.appendChild(element);
      }
      // Set order attribute to render participants in order they were selected.
      element.style.order = this.selectedIdentities.indexOf(
        participant.identity
      );
    } else {
      const participantTarget = this.getParticipantTarget(participant);
      participantTarget?.appendChild(element);
    }
  }

  participantConnected(remoteParticipant) {
    const participant = this.findParticipant(remoteParticipant.identity);

    const div = document.createElement("div");
    const innerDiv = document.createElement("div");
    div.className = `videochat-video-container videochat-video-container-${participant.participant_type}`;
    div.dataset.identity = remoteParticipant.identity;
    innerDiv.className = "videochat-video-container--inner";

    const nameSpan = document.createElement("span");
    const shadowDiv = document.createElement("div");
    shadowDiv.className = "videochat-video-container--shadow";
    nameSpan.textContent = participant.familiar_name;
    div.appendChild(innerDiv);
    innerDiv.appendChild(nameSpan);
    innerDiv.appendChild(shadowDiv);

    if (remoteParticipant.on) {
      remoteParticipant.on("trackSubscribed", (track) =>
        innerDiv.appendChild(track.attach())
      );
      remoteParticipant.on("trackUnsubscribed", (track) =>
        track.detach().forEach((element) => element.remove())
      );
      remoteParticipant.on(
        "networkQualityLevelChanged",
        (networkQualityLevel) => {
          participant.networkQualityLevel = networkQualityLevel;
          this.updateParticipantTarget(participant);
        }
      );
    }

    remoteParticipant.tracks.forEach((publication) => {
      if (publication.isSubscribed) {
        innerDiv.appendChild(publication.track.attach());
      }
    });

    participant.div = div;
    participant.state = "connected";
    participant.networkQualityLevel = remoteParticipant.networkQualityLevel;
    participant.remoteParticipant = remoteParticipant;

    if (this.isLocalParticipant(remoteParticipant)) {
      div.classList.add("is-local");
    } else if (this.data.get("autoselect") === "true") {
      // In case of one-on-one videochats, we automatically select the other participant.
      this.selectParticipant(participant);
      this.updateStateClasses();
    }

    this.renderParticipants();
    this.updateParticipantTarget(participant);
  }

  participantDisconnected(participantData) {
    const participant = this.findParticipant(participantData.identity);
    participant.div.remove();
    participant.state = "disconnected";
    participant.remoteParticipant = undefined;
    this.deselectParticipant(participant);
    this.updateStateClasses();
    this.renderParticipant(participant);
    this.updateParticipantTarget(participant);
  }

  localNetworkQualityLevelChanged(networkQualityLevel) {
    const localParticipant = this.findParticipant(
      this.data.get("local-identity")
    );
    localParticipant.networkQualityLevel = networkQualityLevel;
    this.updateParticipantTarget(localParticipant);

    this.toggleBadSignalWarning(networkQualityLevel);
  }

  toggleBadSignalWarning(networkQualityLevel) {
    const newBadSignal = networkQualityLevel < BAD_SIGNAL_THRESHOLD;

    // Add delay for setting badSignal to false, so message stays long enough for users to be able to read it.
    const delay = this.badSignal && !newBadSignal ? 5000 : 0;
    _.delay(() => {
      this.badSignal = newBadSignal;
      this.updateStateClasses();
    }, delay);
  }

  dismissBadSignal() {
    this.hideBadSignalWarning = true;
    this.updateStateClasses();
  }

  disconnectChat(event) {
    event?.preventDefault();

    const { room } = this;
    this.room = null;
    room.disconnect();
  }

  completeChat(event) {
    if (event.detail.answer === true) {
      this.disconnectChat();
    }
  }

  cleanup(room) {
    room.participants.forEach(this.participantDisconnected.bind(this));
    this.reset();
    this.updateUI();
    // Rerender to move local participant to correct place.
    this.renderParticipants();
  }

  mute() {
    this.muted = true;
    this.room.localParticipant.audioTracks.forEach((audioTrack) => {
      audioTrack.track.disable();
    });
    this.channel.perform("mute");
    this.updateStateClasses();
  }

  unmute() {
    this.muted = false;
    this.room.localParticipant.audioTracks.forEach((audioTrack) => {
      audioTrack.track.enable();
    });
    this.channel.perform("unmute");
    this.updateStateClasses();
  }

  pause() {
    this.paused = true;
    this.room.localParticipant.videoTracks.forEach((videoTrack) => {
      videoTrack.track.disable();
    });
    this.channel.perform("pause");
    this.updateStateClasses();
  }

  unpause() {
    this.paused = false;
    this.room.localParticipant.videoTracks.forEach((videoTrack) => {
      videoTrack.track.enable();
    });
    this.channel.perform("unpause");
    this.updateStateClasses();
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      this.windowTarget.requestFullscreen();
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }

  setPreferred(event) {
    const videoContainer = event.target.closest(".videochat-video-container");

    if (videoContainer) {
      const { identity } = videoContainer.dataset;
      if (this.mainIdentity === identity) {
        this.mainIdentity = null;
      } else {
        this.mainIdentity = identity;
      }
      this.updateStateClasses();
      this.renderParticipants();
      this.updateParticipantTargets();
    }
  }

  isSelectedParticipant(participant) {
    return this.selectedIdentities.indexOf(participant.identity) !== -1;
  }

  selectParticipant(participant) {
    if (!this.isParticipantConnected(participant)) return;
    if (this.isSelectedParticipant(participant)) return;

    this.selectedIdentities.push(participant.identity);
    this.broadcastCurrentlyViewing();
  }

  deselectParticipant(participant) {
    if (!this.isSelectedParticipant(participant)) return;

    _.pull(this.selectedIdentities, participant.identity);
    if (this.mainIdentity === participant.identity) {
      this.mainIdentity = null;
    }
    this.broadcastCurrentlyViewing();
  }

  broadcastCurrentlyViewing() {
    if (!this.isConnected()) return;

    this.channel.perform("update_currently_viewing", {
      currently_viewing: this.selectedIdentities,
    });
  }

  // The local participant is always regarded as connected, all other participants only if we are currently connected to the room, and the participant is connected.
  isParticipantConnected(participant) {
    return (
      (this.isConnected() && participant.state === "connected") ||
      this.isLocalParticipant(participant)
    );
  }

  isLocalParticipant(participant) {
    return participant.identity === this.data.get("local-identity");
  }

  toggleParticipant(event) {
    // Don't toggle for links or buttons or icons
    if (
      event.target.tagName === "A" ||
      event.target.tagName === "BUTTON" ||
      event.target.tagName === "I"
    ) {
      return;
    }

    event.preventDefault();

    const participantEl = event.target.closest(".videochat-participant");
    const participant = this.findParticipant(participantEl.dataset.identity);

    if (this.isSelectedParticipant(participant)) {
      this.deselectParticipant(participant);
    } else {
      this.selectParticipant(participant);
    }

    this.updateParticipantTarget(participant);
    this.updateStateClasses();
    this.renderParticipants();
  }

  cycleView(event) {
    event.preventDefault();

    if (this.selectedIdentities.length <= 1) return;

    if (this.mainIdentity) {
      const nextIndex = this.selectedIdentities.indexOf(this.mainIdentity) + 1;

      if (nextIndex >= this.selectedIdentities.length) {
        this.mainIdentity = null;
      } else {
        this.mainIdentity = this.selectedIdentities[nextIndex];
      }
    } else {
      // eslint-disable-next-line prefer-destructuring
      this.mainIdentity = this.selectedIdentities[0];
    }

    this.updateParticipantTargets();
    this.updateStateClasses();
    this.renderParticipants();
  }
}
