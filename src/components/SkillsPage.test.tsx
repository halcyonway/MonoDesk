// SkillsPage 单测 — list / 选中 / 编辑 / 保存 / 删除 / 上传 / 错误处理。
//
// 模板仿 TraceDrawer.test.tsx：FakeClient + vi.fn + waitFor。

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SkillsPage } from "./SkillsPage";
import type { SkillsClient } from "../skills/client";
import type { SkillFull, SkillMeta } from "../skills/types";

// ---- FakeClient ----

class FakeClient {
  list = vi.fn();
  get = vi.fn();
  save = vi.fn();
  remove = vi.fn();
  upload = vi.fn();
  invalidate = vi.fn();

  static make(): SkillsClient {
    return new FakeClient() as unknown as SkillsClient;
  }
}

const SAMPLE: SkillMeta[] = [
  { name: "foo", description: "Foo desc", tier: 1, path: "/x/foo" },
  { name: "rare", description: "Rare desc", tier: 2, path: "/x/rare" },
];

const FOO_FULL: SkillFull = {
  ...SAMPLE[0],
  body: "---\ndescription: Foo desc\n---\n# Foo\n",
};

// ---- Tests ----

describe("SkillsPage", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.list.mockResolvedValue(SAMPLE);
    client.get.mockResolvedValue(FOO_FULL);
    client.save.mockResolvedValue(undefined);
    client.remove.mockResolvedValue(undefined);
    client.upload.mockResolvedValue({ added: ["uploaded"] });
    // confirm dialog auto-accept
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders empty state when no skills", async () => {
    client.list.mockResolvedValue([]);
    render(<SkillsPage client={client as unknown as SkillsClient} />);
    await waitFor(() => {
      screen.getByText(/No skills yet/i);
    });
  });

  it("renders loading state initially", () => {
    // list never resolves → stays loading
    client.list.mockReturnValue(new Promise(() => {}));
    render(<SkillsPage client={client as unknown as SkillsClient} />);
      screen.getByText(/Loading/i);
  });

  it("lists skills with tier badges", async () => {
    render(<SkillsPage client={client as unknown as SkillsClient} />);
    await waitFor(() => {
      screen.getByText("foo");
    });
      screen.getByText("rare");
      screen.getByText("L1");
      screen.getByText("L2");
      screen.getByText("Foo desc");
  });

  it("selecting a skill loads its body into the editor", async () => {
    render(<SkillsPage client={client as unknown as SkillsClient} />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getByText("foo"));
    await waitFor(() => {
      const ta = screen.getByPlaceholderText(/SKILL\.md content/i) as HTMLTextAreaElement;
      expect(ta.value).toBe(FOO_FULL.body);
    });
    expect(client.get).toHaveBeenCalledWith("foo");
  });

  it("editing + Save calls client.save and invalidates list", async () => {
    render(<SkillsPage client={client as unknown as SkillsClient} />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getByText("foo"));
    const ta = await screen.findByPlaceholderText(/SKILL\.md content/i) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "edited body" } });
    // 等 Save 按钮变 enabled（dirty state 更新）
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
    const saveBtn = screen.getByRole("button", { name: /^Save$/ });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(client.save).toHaveBeenCalledWith("foo", "edited body");
    });
    // save 成功后页面会重新拉 list（refresh 调 client.invalidate + client.list）
    await waitFor(() => {
      expect(client.list.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it("Save button disabled when not dirty", async () => {
    render(<SkillsPage client={client as unknown as SkillsClient} />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getByText("foo"));
    await screen.findByPlaceholderText(/SKILL\.md content/i);
    const saveBtn = screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it("Delete shows confirm modal; confirm calls client.remove", async () => {
    render(<SkillsPage client={client as unknown as SkillsClient} />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getByText("foo"));
    await screen.findByPlaceholderText(/SKILL\.md content/i);
    // detail-actions 里的 Delete 按钮（唯一的，list item 没 Delete）
    const delBtn = screen.getByRole("button", { name: /^Delete$/ });
    fireEvent.click(delBtn);
    // confirm modal 出现
    await waitFor(() => screen.getByText(/permanently removes/i));
    // modal 里的 Delete 按钮（现在有两个 Delete button：detail-actions 那个 + modal 这个）
    const allDelBtns = screen.getAllByRole("button", { name: /^Delete$/ });
    const modalDel = allDelBtns[allDelBtns.length - 1];
    fireEvent.click(modalDel);
    await waitFor(() => {
      expect(client.remove).toHaveBeenCalledWith("foo");
    });
  });

  it("upload zip: file input change triggers client.upload", async () => {
    render(<SkillsPage client={client as unknown as SkillsClient} />);
    await waitFor(() => screen.getByText("foo"));
    // Upload .zip label 内嵌一个 hidden file input
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const blob = new Blob([new Uint8Array([0x50, 0x4b])], { type: "application/zip" });
    Object.defineProperty(fileInput, "files", {
      value: [{ name: "pack.zip" }],
      configurable: true,
    });
    fireEvent.change(fileInput);
    await waitFor(() => {
      expect(client.upload).toHaveBeenCalled();
    });
  });

  it("error from list shows error banner", async () => {
    client.list.mockRejectedValue(new Error("network down"));
    render(<SkillsPage client={client as unknown as SkillsClient} />);
    await waitFor(() => {
      screen.getByText(/network down/i);
    });
  });

  it("New skill modal: enter name creates and selects", async () => {
    render(<SkillsPage client={client as unknown as SkillsClient} />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getByRole("button", { name: /New skill/ }));
    await screen.findByPlaceholderText("skill-name");
    const input = screen.getByPlaceholderText("skill-name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "fresh" } });
    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
    await waitFor(() => {
      expect(client.save).toHaveBeenCalledWith("fresh", expect.stringContaining("name: fresh"));
    });
  });

  it("New skill modal: invalid name shows error and disables Create", async () => {
    render(<SkillsPage client={client as unknown as SkillsClient} />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getByRole("button", { name: /New skill/ }));
    const input = await screen.findByPlaceholderText("skill-name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "with space!" } });
    screen.getByText(/Allowed:/);
    const createBtn = screen.getByRole("button", { name: /^Create$/ }) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
  });

  it("New skill modal: existing name is rejected", async () => {
    render(<SkillsPage client={client as unknown as SkillsClient} />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getByRole("button", { name: /New skill/ }));
    const input = await screen.findByPlaceholderText("skill-name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "foo" } });
      screen.getByText(/already exists/);
  });
});
