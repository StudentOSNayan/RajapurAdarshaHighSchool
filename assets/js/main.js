/* Shared interactions for Rajapur Adarsha High School */
(() => {
  "use strict";

  const header = document.querySelector(".site-header");
  const menuButton = document.getElementById("navToggle");
  const mobileMenu = document.getElementById("mobileMenu");
  const toTop = document.getElementById("toTop");

  const setMenu = (isOpen) => {
    if (!menuButton || !mobileMenu) return;
    menuButton.setAttribute("aria-expanded", String(isOpen));
    menuButton.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
    mobileMenu.hidden = !isOpen;
  };

  if (menuButton && mobileMenu) {
    menuButton.addEventListener("click", () => {
      setMenu(menuButton.getAttribute("aria-expanded") !== "true");
    });

    mobileMenu.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => setMenu(false));
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && menuButton.getAttribute("aria-expanded") === "true") {
        setMenu(false);
        menuButton.focus();
      }
    });
  }

  const updateScrollState = () => {
    const scrolled = window.scrollY > 12;
    header?.classList.toggle("is-scrolled", scrolled);
    toTop?.classList.toggle("is-visible", window.scrollY > 520);
  };

  window.addEventListener("scroll", updateScrollState, { passive: true });
  updateScrollState();

  toTop?.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  document.querySelectorAll("[data-current-year]").forEach((node) => {
    node.textContent = new Date().getFullYear();
  });

  const gallery = document.querySelector("[data-gallery]");
  if (!gallery) return;

  const filterButtons = Array.from(gallery.querySelectorAll("[data-filter]"));
  const galleryItems = Array.from(gallery.querySelectorAll("[data-gallery-item]"));
  const status = document.getElementById("galleryStatus");
  const dialog = document.getElementById("lightbox");
  const dialogImage = document.getElementById("lightboxImage");
  const dialogTitle = document.getElementById("lightboxTitle");
  const dialogDescription = document.getElementById("lightboxDescription");
  const closeButton = document.getElementById("lightboxClose");
  const previousButton = document.getElementById("lightboxPrevious");
  const nextButton = document.getElementById("lightboxNext");

  let activeFilter = "all";
  let activeItem = null;
  let lastTrigger = null;

  const visibleItems = () => galleryItems.filter((item) => !item.hidden);

  const announceCount = () => {
    if (!status) return;
    const count = visibleItems().length;
    status.textContent = `${count} photo${count === 1 ? "" : "s"} shown.`;
  };

  const applyFilter = (filter) => {
    activeFilter = filter;

    galleryItems.forEach((item) => {
      const tags = (item.dataset.tags || "").split(" ");
      item.hidden = filter !== "all" && !tags.includes(filter);
    });

    filterButtons.forEach((button) => {
      const selected = button.dataset.filter === filter;
      button.setAttribute("aria-pressed", String(selected));
    });

    announceCount();
  };

  filterButtons.forEach((button) => {
    button.addEventListener("click", () => applyFilter(button.dataset.filter || "all"));
  });

  const updateDialogControls = () => {
    if (!previousButton || !nextButton) return;
    const hasMoreThanOne = visibleItems().length > 1;
    previousButton.disabled = !hasMoreThanOne;
    nextButton.disabled = !hasMoreThanOne;
  };

  const populateDialog = (item) => {
    const trigger = item.querySelector("[data-gallery-open]");
    if (!trigger || !dialogImage || !dialogTitle || !dialogDescription) return;

    dialogImage.src = trigger.dataset.image || "";
    dialogImage.alt = trigger.dataset.alt || "";
    dialogTitle.textContent = trigger.dataset.title || "School photograph";
    dialogDescription.textContent = trigger.dataset.description || "";
    activeItem = item;
    updateDialogControls();
  };

  const openDialog = (item, trigger) => {
    if (!dialog) return;
    lastTrigger = trigger;
    populateDialog(item);

    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }

    closeButton?.focus();
  };

  const closeDialog = () => {
    if (!dialog) return;
    if (typeof dialog.close === "function" && dialog.open) {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
      lastTrigger?.focus();
    }
  };

  const stepDialog = (direction) => {
    const items = visibleItems();
    if (!activeItem || items.length < 2) return;
    const currentIndex = items.indexOf(activeItem);
    const nextIndex = (currentIndex + direction + items.length) % items.length;
    populateDialog(items[nextIndex]);
  };

  galleryItems.forEach((item) => {
    const trigger = item.querySelector("[data-gallery-open]");
    trigger?.addEventListener("click", () => openDialog(item, trigger));
  });

  closeButton?.addEventListener("click", closeDialog);
  previousButton?.addEventListener("click", () => stepDialog(-1));
  nextButton?.addEventListener("click", () => stepDialog(1));

  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });

  dialog?.addEventListener("close", () => {
    lastTrigger?.focus();
  });

  document.addEventListener("keydown", (event) => {
    if (!dialog?.open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepDialog(-1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      stepDialog(1);
    }
  });

  applyFilter(activeFilter);
})();
