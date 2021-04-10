mainImage.src = "/public/uploads/"+comicFolder+"/"+comicImages[lastTime];
xView = lastTime;

document.getElementById("totalPage").innerHTML = comicImagesLength;
document.getElementById("currentPage").innerHTML = xView+1;
window.addEventListener("contextmenu",(event_t)=>{
    event_t.preventDefault();
})

var cachedImage = document.getElementById("cachedImage");
var closeInfoComic = document.getElementById("closeInfoComic");
var backToStart = document.getElementById("backToStart");
backToStart.addEventListener("click",()=>{
    backToStartFun();
})
function backToStartFun(){
    xView = 0;
    mainImage.src = "/public/uploads/"+comicFolder+"/"+comicImages[xView];
    backToStart.style.display = "none";
    TriggerLeftorRight();
}
function rightTriggerArrow(event_t){
        event_t.preventDefault();
        xView++;
        if(xView >= comicImagesLength-1){
            xView = comicImagesLength-1;
            backToStart.style.display = "";
        }
        mainImage.src = "/public/uploads/"+comicFolder+"/"+comicImages[xView] ;
        TriggerLeftorRight();
}
function leftTriggerArrow(event_t){
        event_t.preventDefault();
        xView--;
        if(xView < 0){
            xView = 0
        }
        mainImage.src = "/public/uploads/"+comicFolder+"/"+comicImages[xView] ;
        TriggerLeftorRight();
}

function TriggerLeftorRight(){
    window.localStorage[comicFolder] = xView;
    document.getElementById("infoComic").style.visibility = "hidden";
    document.getElementById("rightTrigger").style.visibility = "visible";
    document.getElementById("leftTrigger").style.visibility = "visible";
    document.getElementById("currentPage").innerHTML = xView+1;
}
 // onloadedmetadata="cacheNextImage()"
function cacheNextImage(){
    setTimeout(()=>{
    cachedImage.src = "/public/uploads/"+comicFolder+"/"+comicImages[(xView+1)%comicImagesLength];
    fetch("/ajax/lastpage/update/"+comicId+"/"+xView);
    },500)
}

closeInfoComic.addEventListener("click",()=>{
    TriggerLeftorRight();
})

mainImage.addEventListener("mousedown",(event_t)=>{
        if(event_t.button == 0){
            rightTriggerArrow(event_t);
        }
        if(event_t.button == 2){
            leftTriggerArrow(event_t);
        }
})

document.getElementById("rightTrigger").addEventListener("mousedown",(event_t)=>{
    rightTriggerArrow(event_t);
})
document.getElementById("leftTrigger").addEventListener("mousedown",(event_t)=>{
    leftTriggerArrow(event_t);
})

document.addEventListener("keydown",(event_t)=>{
    // key space " " or ArrowRight ->
    if(event_t.key == " " || event_t.key == "ArrowRight"){
        rightTriggerArrow(event_t);
    }
    // key ArrowLeft <-
    if(event_t.key == "ArrowLeft"){
        leftTriggerArrow(event_t);
    }
    if(event_t.key == "r" && backToStart.style.display == ""){
        backToStartFun();
    }
    if(event_t.key == "f"){
        toggleFullScreen();
    }
})

document.getElementById("infoComic_details").addEventListener("mousedown",()=>{
    document.getElementById("infoComic").style.visibility = "visible";
    document.getElementById("rightTrigger").style.visibility = "hidden";
    document.getElementById("leftTrigger").style.visibility = "hidden";
});


document.getElementById("backToComics").addEventListener("click",()=>{
    window.location.href = "/comic";
})
var fullScreen_icon = document.getElementById("fullScreen_icon");
fullScreen_icon.addEventListener("click",()=>{
    toggleFullScreen();
})
function toggleFullScreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
        fullScreen_icon.innerHTML = `<i class="mx-2 fas fa-compress"></i>`;
    } else {
      if (document.exitFullscreen) {
        fullScreen_icon.innerHTML = `<i class="mx-2 fas fa-expand"></i>`;
        document.exitFullscreen();
      }
    }
  }