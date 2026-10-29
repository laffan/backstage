import AVFoundation
import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

// MARK: - Wire types (mirrored in src/player.ts)

struct PlayArgs: Decodable {
  let id: String
}

struct RemoveArgs: Decodable {
  let id: String
}

struct OptionsArgs: Decodable {
  let muted: Bool?
  let repeatMode: String?
  let gravity: String?
  let keepAwake: Bool?
}

struct Options: Codable {
  /// Muted by default: a backdrop should not take over the audio session.
  var muted = true
  /// "one" loops the current video gaplessly, "all" advances through the library.
  var repeatMode = "one"
  /// "fill" crops to cover the screen, "fit" letterboxes, "stretch" distorts.
  var gravity = "fill"
  var keepAwake = true
}

struct Video: Encodable {
  let id: String
  let name: String
  /// "picked": opened in place from Files (security-scoped bookmark).
  /// "documents": copied into the app's own folder via Files/Finder.
  let source: String
  let size: Int64?
  let available: Bool
}

struct PlayerState: Encodable {
  let native = true
  let currentId: String?
  let playing: Bool
  let options: Options
  let library: [Video]
  let error: String?
}

/// A file picked from the Files app. The bookmark lets us reopen it in place
/// on later launches without copying gigabytes into the sandbox.
struct Bookmark: Codable {
  let id: String
  let name: String
  var data: Data
}

// MARK: - Player view

/// A view backed directly by an AVPlayerLayer, so it resizes with rotation and
/// Stage Manager without any layout code.
final class PlayerView: UIView {
  override class var layerClass: AnyClass { AVPlayerLayer.self }
  var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

// MARK: - Plugin

class PlayerPlugin: Plugin, UIDocumentPickerDelegate {
  private let defaults = UserDefaults.standard
  private let bookmarksKey = "backstage.bookmarks"
  private let optionsKey = "backstage.options"
  private let lastIdKey = "backstage.lastId"

  private let playerView = PlayerView()
  private let player = AVQueuePlayer()
  private var looper: AVPlayerLooper?
  private var endObserver: NSObjectProtocol?

  private var bookmarks: [Bookmark] = []
  private var options = Options()
  private var currentId: String?
  private var scopedURL: URL?
  /// What the user asked for; the system may pause us (backgrounding) without changing it.
  private var wantsPlaying = false
  private var lastError: String?
  private var pendingPick: Invoke?

  private var documentsURL: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
  }

  // MARK: Lifecycle

  @objc public override func load(webview: WKWebView) {
    loadPersisted()

    // Ambient: never interrupts the user's music, respects the silent switch.
    try? AVAudioSession.sharedInstance().setCategory(.ambient)

    player.automaticallyWaitsToMinimizeStalling = true
    player.allowsExternalPlayback = false
    applyOptions()

    playerView.backgroundColor = .black
    playerView.playerLayer.player = player

    // Let the native layer show through the page.
    webview.isOpaque = false
    webview.backgroundColor = .clear
    webview.scrollView.backgroundColor = .clear
    webview.scrollView.isScrollEnabled = false
    webview.scrollView.bounces = false
    webview.scrollView.contentInsetAdjustmentBehavior = .never

    let center = NotificationCenter.default
    center.addObserver(
      self, selector: #selector(didEnterBackground),
      name: UIApplication.didEnterBackgroundNotification, object: nil)
    center.addObserver(
      self, selector: #selector(willEnterForeground),
      name: UIApplication.willEnterForegroundNotification, object: nil)

    DispatchQueue.main.async {
      self.attach(below: webview, attempts: 20)
      self.hideSystemOverlays()
      if let lastId = self.defaults.string(forKey: self.lastIdKey) {
        self.start(id: lastId)
      }
    }
  }

  /// The webview is handed to plugins as soon as it is created, possibly before
  /// it is in the view hierarchy, so wait for it to get a superview.
  private func attach(below webview: WKWebView, attempts: Int) {
    guard let host = webview.superview else {
      if attempts > 0 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
          self.attach(below: webview, attempts: attempts - 1)
        }
      }
      return
    }
    host.backgroundColor = .black
    playerView.frame = host.bounds
    playerView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    host.insertSubview(playerView, belowSubview: webview)
  }

  /// Tao's root view controller exposes setters for these UIViewController
  /// preferences (and calls the matching setNeeds…Update), so use them via KVC.
  /// Deferring the screen edges means a first swipe only reveals the home
  /// indicator / Control Center grabber instead of leaving the app.
  private func hideSystemOverlays() {
    guard let vc = manager.viewController else { return }
    let prefs: [(key: String, setter: String, value: Any)] = [
      ("prefersStatusBarHidden", "setPrefersStatusBarHidden:", true),
      ("prefersHomeIndicatorAutoHidden", "setPrefersHomeIndicatorAutoHidden:", true),
      (
        "preferredScreenEdgesDeferringSystemGestures",
        "setPreferredScreenEdgesDeferringSystemGestures:", UIRectEdge.all.rawValue
      ),
    ]
    // Guarded: KVC on a key without a setter would raise an ObjC exception.
    for pref in prefs where vc.responds(to: NSSelectorFromString(pref.setter)) {
      vc.setValue(pref.value, forKey: pref.key)
    }
  }

  @objc private func didEnterBackground() {
    player.pause()
  }

  @objc private func willEnterForeground() {
    if wantsPlaying {
      player.play()
    }
    emit()
  }

  // MARK: Commands

  @objc public func getState(_ invoke: Invoke) {
    DispatchQueue.main.async { invoke.resolve(self.state()) }
  }

  @objc public func pickVideos(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard let vc = self.manager.viewController else {
        invoke.reject("No view controller to present the picker from")
        return
      }
      // asCopy: false opens files in place. Copying a 10 GB file into the
      // sandbox would double its storage and take minutes.
      let picker = UIDocumentPickerViewController(
        forOpeningContentTypes: [.movie, .video, .audiovisualContent], asCopy: false)
      picker.allowsMultipleSelection = true
      picker.delegate = self
      self.pendingPick = invoke
      vc.present(picker, animated: true)
    }
  }

  @objc public func play(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PlayArgs.self)
    DispatchQueue.main.async {
      self.start(id: args.id)
      invoke.resolve(self.state())
    }
  }

  @objc public func next(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.advance()
      invoke.resolve(self.state())
    }
  }

  @objc public func pause(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.wantsPlaying = false
      self.player.pause()
      invoke.resolve(self.state())
    }
  }

  @objc public func resume(_ invoke: Invoke) {
    DispatchQueue.main.async {
      if self.currentId != nil {
        self.wantsPlaying = true
        self.player.play()
      }
      invoke.resolve(self.state())
    }
  }

  @objc public func stop(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.unload()
      self.defaults.removeObject(forKey: self.lastIdKey)
      invoke.resolve(self.state())
    }
  }

  @objc public func remove(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(RemoveArgs.self)
    DispatchQueue.main.async {
      if args.id.hasPrefix("doc:") {
        // Files the user put in the app's folder are theirs; deleting them
        // happens in the Files app, not here.
        invoke.reject("Delete files in the app's folder from the Files app")
        return
      }
      if args.id == self.currentId {
        self.unload()
        self.defaults.removeObject(forKey: self.lastIdKey)
      }
      self.bookmarks.removeAll { $0.id == args.id }
      self.saveBookmarks()
      invoke.resolve(self.state())
    }
  }

  @objc public func setOptions(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OptionsArgs.self)
    DispatchQueue.main.async {
      let previousRepeat = self.options.repeatMode
      if let muted = args.muted { self.options.muted = muted }
      if let mode = args.repeatMode, ["one", "all"].contains(mode) { self.options.repeatMode = mode }
      if let gravity = args.gravity, ["fill", "fit", "stretch"].contains(gravity) {
        self.options.gravity = gravity
      }
      if let keepAwake = args.keepAwake { self.options.keepAwake = keepAwake }
      self.saveOptions()
      self.applyOptions()
      // Switching between looping and advancing needs a different item setup.
      if previousRepeat != self.options.repeatMode, let id = self.currentId {
        let time = self.player.currentTime()
        self.start(id: id, at: time, autoplay: self.wantsPlaying)
      }
      invoke.resolve(self.state())
    }
  }

  // MARK: Document picker

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    var firstNewId: String?
    for url in urls {
      let accessing = url.startAccessingSecurityScopedResource()
      defer { if accessing { url.stopAccessingSecurityScopedResource() } }
      guard
        let data = try? url.bookmarkData(
          options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
      else { continue }
      let id = "bm:" + UUID().uuidString
      bookmarks.append(Bookmark(id: id, name: url.lastPathComponent, data: data))
      firstNewId = firstNewId ?? id
    }
    saveBookmarks()
    // Picking something while nothing is playing starts it right away.
    if currentId == nil, let id = firstNewId {
      start(id: id)
    }
    pendingPick?.resolve(state())
    pendingPick = nil
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    pendingPick?.resolve(state())
    pendingPick = nil
  }

  // MARK: Playback

  private func start(id: String, at time: CMTime = .zero, autoplay: Bool = true) {
    unload()
    guard let url = resolve(id: id) else {
      lastError = "This video is no longer available. It may have been moved, renamed or deleted."
      emit()
      return
    }
    if id.hasPrefix("bm:"), url.startAccessingSecurityScopedResource() {
      scopedURL = url
    }
    // iCloud Drive files that are not downloaded yet: ask for them, AVPlayer
    // will start once enough is local.
    try? FileManager.default.startDownloadingUbiquitousItem(at: url)

    currentId = id
    lastError = nil
    wantsPlaying = autoplay
    defaults.set(id, forKey: lastIdKey)

    // Precise timing would make AVFoundation scan the whole file up front.
    let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: false])
    let item = makeItem(asset)

    if options.repeatMode == "one" {
      looper = AVPlayerLooper(player: player, templateItem: item)
    } else {
      player.insert(item, after: nil)
      endObserver = NotificationCenter.default.addObserver(
        forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
      ) { [weak self] _ in
        self?.advance()
      }
    }
    if time != .zero {
      player.seek(to: time, toleranceBefore: .positiveInfinity, toleranceAfter: .positiveInfinity)
    }
    if autoplay {
      player.play()
    }
    emit()

    Task { @MainActor in
      let playable = (try? await asset.load(.isPlayable)) ?? false
      guard !playable, self.currentId == id else { return }
      self.unload()
      self.defaults.removeObject(forKey: self.lastIdKey)
      self.currentId = id
      self.lastError =
        "\(url.lastPathComponent) can't be played. iPadOS plays MP4, MOV and M4V files "
        + "(H.264, HEVC, ProRes). MKV and WebM files need to be remuxed first."
      self.emit()
    }
  }

  private func makeItem(_ asset: AVAsset) -> AVPlayerItem {
    let item = AVPlayerItem(asset: asset)
    // Keep only a few seconds decoded ahead; plenty for local files and keeps
    // memory flat even for very high bitrate sources.
    item.preferredForwardBufferDuration = 5
    return item
  }

  private func advance() {
    let ids = library().filter(\.available).map(\.id)
    guard !ids.isEmpty else { return }
    let index = currentId.flatMap { ids.firstIndex(of: $0) } ?? -1
    start(id: ids[(index + 1) % ids.count])
  }

  private func unload() {
    player.pause()
    looper?.disableLooping()
    looper = nil
    player.removeAllItems()
    if let observer = endObserver {
      NotificationCenter.default.removeObserver(observer)
      endObserver = nil
    }
    scopedURL?.stopAccessingSecurityScopedResource()
    scopedURL = nil
    currentId = nil
    wantsPlaying = false
  }

  private func applyOptions() {
    player.isMuted = options.muted
    player.preventsDisplaySleepDuringVideoPlayback = options.keepAwake
    switch options.gravity {
    case "fit": playerView.playerLayer.videoGravity = .resizeAspect
    case "stretch": playerView.playerLayer.videoGravity = .resize
    default: playerView.playerLayer.videoGravity = .resizeAspectFill
    }
  }

  // MARK: Library

  private func resolve(id: String) -> URL? {
    if id.hasPrefix("doc:") {
      let url = documentsURL.appendingPathComponent(String(id.dropFirst(4)))
      return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
    guard let index = bookmarks.firstIndex(where: { $0.id == id }) else { return nil }
    var stale = false
    guard
      let url = try? URL(
        resolvingBookmarkData: bookmarks[index].data, options: [], relativeTo: nil,
        bookmarkDataIsStale: &stale)
    else { return nil }
    if stale {
      let accessing = url.startAccessingSecurityScopedResource()
      if let fresh = try? url.bookmarkData(
        options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
      {
        bookmarks[index].data = fresh
        saveBookmarks()
      }
      if accessing { url.stopAccessingSecurityScopedResource() }
    }
    return url
  }

  private func library() -> [Video] {
    var videos: [Video] = []

    let keys: [URLResourceKey] = [.fileSizeKey, .contentTypeKey, .isRegularFileKey]
    let files =
      (try? FileManager.default.contentsOfDirectory(
        at: documentsURL, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])) ?? []
    for url in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
      guard let values = try? url.resourceValues(forKeys: Set(keys)),
        values.isRegularFile == true,
        let type = values.contentType, type.conforms(to: .audiovisualContent)
      else { continue }
      videos.append(
        Video(
          id: "doc:" + url.lastPathComponent, name: url.lastPathComponent, source: "documents",
          size: values.fileSize.map { Int64($0) }, available: true))
    }

    for bookmark in bookmarks {
      var size: Int64?
      var available = false
      if let url = resolve(id: bookmark.id) {
        let accessing = url.startAccessingSecurityScopedResource()
        available = FileManager.default.fileExists(atPath: url.path)
        size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize.map { Int64($0) }
        if accessing { url.stopAccessingSecurityScopedResource() }
      }
      videos.append(
        Video(id: bookmark.id, name: bookmark.name, source: "picked", size: size, available: available))
    }
    return videos
  }

  // MARK: State

  private func state() -> PlayerState {
    PlayerState(
      currentId: currentId, playing: wantsPlaying && currentId != nil, options: options,
      library: library(), error: lastError)
  }

  /// Pushes state changes the webview did not ask for (end of item, errors).
  private func emit() {
    try? trigger("state", data: state())
  }

  private func loadPersisted() {
    if let data = defaults.data(forKey: bookmarksKey),
      let saved = try? JSONDecoder().decode([Bookmark].self, from: data)
    {
      bookmarks = saved
    }
    if let data = defaults.data(forKey: optionsKey),
      let saved = try? JSONDecoder().decode(Options.self, from: data)
    {
      options = saved
    }
  }

  private func saveBookmarks() {
    defaults.set(try? JSONEncoder().encode(bookmarks), forKey: bookmarksKey)
  }

  private func saveOptions() {
    defaults.set(try? JSONEncoder().encode(options), forKey: optionsKey)
  }
}

@_cdecl("init_plugin_player")
public func initPlugin() -> Plugin {
  return PlayerPlugin()
}
